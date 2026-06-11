require("dotenv/config");
const { createJupiterApiClient } = require("@jup-ag/api");
const { Connection, Keypair, VersionedTransaction } = require("@solana/web3.js");
const bs58 = require("bs58").default;

const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

const connection = new Connection("https://api.devnet.solana.com");
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.DEVNET_PRIVATE_KEY));
const jupiterApi = createJupiterApiClient();

// swap.js - Versión corregida (solo cambia esta parte)

async function executeSwap() {
  console.log("\n🚀 INICIANDO SWAP EN DEVNET");
  console.log("=".repeat(50));

  try {
    const balanceSOL = await connection.getBalance(wallet.publicKey);
    console.log(`💰 Balance inicial: ${balanceSOL / 1e9} SOL`);

    if (balanceSOL < 0.01 * 1e9) {
      console.log("❌ Balance insuficiente.");
      return;
    }

    const amountInLamports = 0.01 * 1e9;
    console.log(`\n📊 Buscando ruta para ${amountInLamports / 1e9} SOL → USDC...`);

    const quote = await jupiterApi.quoteGet({
      inputMint: TOKENS.SOL,
      outputMint: TOKENS.USDC,
      amount: amountInLamports,
      slippageBps: 100,
    });

    console.log(`✅ Ruta encontrada:`);
    console.log(`   - Output esperado: ${quote.outAmount / 1e6} USDC`);
    console.log(`   - Impacto: ${quote.priceImpactPct}%`);

    if (parseFloat(quote.priceImpactPct) > 5.0) {
      console.log("⚠️ Slippage muy alto. Cancelando.");
      return;
    }

    console.log("\n🔨 Construyendo transacción...");
    const { swapTransaction } = await jupiterApi.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: null,
        // ⬇️ ESTA ES LA LÍNEA MÁGICA: Deshabilita tablas de direcciones
        addressLookupTableAccounts: [], // ✅ Fuerza a no usar tablas
      },
    });

    const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
    let transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);

    console.log("📡 Enviando a Solana...");
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 3,
    });

    console.log(`✅ Transacción enviada!`);
    console.log(`🔗 Ver en explorador: https://explorer.solana.com/tx/${txid}?cluster=devnet`);

    // Esperar confirmación (opcional pero recomendado)
    console.log("⏳ Esperando confirmación...");
    const confirmation = await connection.confirmTransaction(txid, "confirmed");

    const newBalance = await connection.getBalance(wallet.publicKey);
    console.log(`💰 Balance final: ${newBalance / 1e9} SOL`);
    console.log(`✨ Swap completado con éxito!`);
  } catch (error) {
    console.error("\n❌ ERROR:", error.message);

    // Mostrar logs detallados si el error tiene la función getLogs
    if (error.getLogs) {
      const logs = await error.getLogs();
      console.log("📋 Logs detallados:", logs);
    }
  }
}
executeSwap();
