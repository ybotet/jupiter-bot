// execute-swap.js - Versión con confirmación robusta
require("dotenv/config");
const { Connection, Keypair, Transaction } = require("@solana/web3.js");
const bs58 = require("bs58").default;

// ============================================
// CONFIGURACIÓN
// ============================================
const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com");
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.DEVNET_PRIVATE_KEY));

const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

// ============================================
// FUNCIÓN PARA OBTENER UN QUOTE FRESCO
// ============================================
async function getFreshQuote(inputMint, outputMint, amount) {
  console.log(`\n📊 Obteniendo quote fresco para ${amount / 1e9} SOL → USDC...`);

  const quoteUrl = `${process.env.QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=100`;

  const response = await fetch(quoteUrl);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Error HTTP ${response.status}: ${errorText}`);
  }

  const quote = await response.json();

  if (!quote.outAmount) {
    throw new Error("No se encontró una ruta de swap disponible");
  }

  console.log(`✅ Quote fresco: ${quote.outAmount / 1e6} USDC`);
  return quote;
}

// ============================================
// FUNCIÓN PARA EJECUTAR EL SWAP
// ============================================
async function executeSwap(amount, retries = 2) {
  console.log("\n🔨 Construyendo transacción de swap...");

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Obtener quote fresco
      const quote = await getFreshQuote(TOKENS.SOL, TOKENS.USDC, amount);

      // Construir transacción
      const swapResponse = await fetch(process.env.SWAP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.JUPITER_API_KEY,
        },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          asLegacyTransaction: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: attempt === 1 ? "auto" : 100000,
        }),
      });

      if (!swapResponse.ok) {
        const errorText = await swapResponse.text();
        throw new Error(`HTTP ${swapResponse.status}: ${errorText}`);
      }

      const swapData = await swapResponse.json();
      if (!swapData.swapTransaction) {
        throw new Error("Transacción vacía");
      }

      // Deserializar y firmar
      const transaction = Transaction.from(Buffer.from(swapData.swapTransaction, "base64"));
      transaction.sign(wallet);

      // Enviar transacción
      console.log(`📡 Enviando (intento ${attempt})...`);
      const txid = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
        preflightCommitment: "processed",
      });

      console.log(`🔗 ${txid}`);
      console.log("⏳ Esperando confirmación...");

      // ============================================
      // 🔥 SOLUCIÓN: Verificar estado sin blockhash
      // ============================================
      let confirmed = false;
      let attemptsConfirm = 0;
      const maxConfirmAttempts = 15; // 15 intentos * 3 segundos = 45 segundos

      while (!confirmed && attemptsConfirm < maxConfirmAttempts) {
        attemptsConfirm++;
        await new Promise((resolve) => setTimeout(resolve, 3000));

        try {
          const status = await connection.getSignatureStatus(txid);

          if (
            status.value?.confirmationStatus === "confirmed" ||
            status.value?.confirmationStatus === "finalized"
          ) {
            confirmed = true;
            console.log(`✅ Confirmada en bloque: ${status.value.slot || "desconocido"}`);
            break;
          }

          if (status.value?.err) {
            throw new Error(`Error en transacción: ${JSON.stringify(status.value.err)}`);
          }

          console.log(`⏳ Esperando confirmación (${attemptsConfirm}/${maxConfirmAttempts})...`);
        } catch (error) {
          console.log(`⚠️ Error verificando estado: ${error.message}`);
        }
      }

      if (!confirmed) {
        throw new Error(`Transacción no confirmada después de ${maxConfirmAttempts} intentos`);
      }

      return txid;
    } catch (error) {
      console.log(`⚠️ Intento ${attempt} falló: ${error.message}`);
      if (attempt === retries) {
        throw error;
      }
      console.log("⏳ Esperando 5 segundos para reintentar...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// ============================================
// FUNCIÓN PRINCIPAL
// ============================================
async function main() {
  console.log("\n🚀 EJECUTOR DE SWAP (CON QUOTE FRESCO)");
  console.log("=".repeat(50));

  try {
    // Verificar balance
    const balance = await connection.getBalance(wallet.publicKey);
    console.log(`💰 Balance inicial: ${balance / 1e9} SOL`);

    if (balance < 0.02 * 1e9) {
      console.log("❌ Balance insuficiente. Mínimo 0.02 SOL.");
      return;
    }

    // Configurar swap
    const amount = 0.01 * 1e9;

    // Obtener quote inicial para mostrar
    const initialQuote = await getFreshQuote(TOKENS.SOL, TOKENS.USDC, amount);
    console.log(`📊 Quote inicial: ${initialQuote.outAmount / 1e6} USDC`);

    // Ejecutar swap
    const txid = await executeSwap(amount);
    console.log(`\n🎉 Proceso completado. TX: ${txid}`);

    // Balance final
    const newBalance = await connection.getBalance(wallet.publicKey);
    console.log(`💰 Balance final: ${newBalance / 1e9} SOL`);
  } catch (error) {
    console.error("\n❌ ERROR FINAL:", error.message);
  }
}

main();
