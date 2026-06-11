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

async function executeSimpleSwap() {
  console.log("\n🚀 SWAP SIMPLE EN DEVNET");
  console.log("=".repeat(50));

  try {
    const balanceSOL = await connection.getBalance(wallet.publicKey);
    console.log(`💰 Balance inicial: ${balanceSOL / 1e9} SOL`);

    if (balanceSOL < 0.01 * 1e9) {
      console.log("❌ Balance insuficiente.");
      return;
    }

    const amountInLamports = 0.01 * 1e9;
    console.log(`\n📊 Cambiando ${amountInLamports / 1e9} SOL → USDC...`);

    // 1. Obtener quote SOLO de Raydium (evita rutas complejas)
    const quote = await jupiterApi.quoteGet({
      inputMint: TOKENS.SOL,
      outputMint: TOKENS.USDC,
      amount: amountInLamports,
      slippageBps: 100,
      // Forzar DEX específico para evitar tablas
      dexes: ["Raydium"],
      maxAccounts: 1,
    });

    console.log(`✅ Ruta: ${quote.routePlan.map((r) => r.swapInfo.label).join(" → ")}`);
    console.log(`   - Recibirás: ${quote.outAmount / 1e6} USDC`);
    console.log(`   - Impacto: ${quote.priceImpactPct}%`);

    // 2. Construir transacción SIN optimizaciones
    console.log("\n🔨 Construyendo transacción...");
    const { swapTransaction } = await jupiterApi.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        // Deshabilitar TODAS las optimizaciones
        dynamicComputeUnitLimit: false,
        prioritizationFeeLamports: 0,
        addressLookupTableAccounts: [],
      },
    });

    // 3. Firmar y enviar
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
    console.log(`🔗 ${txid}`);
    console.log(`🔍 Ver: https://explorer.solana.com/tx/${txid}?cluster=devnet`);

    // 4. Confirmar
    console.log("⏳ Confirmando...");
    const confirmation = await connection.confirmTransaction(txid, "confirmed");

    const newBalance = await connection.getBalance(wallet.publicKey);
    console.log(`💰 Balance final: ${newBalance / 1e9} SOL`);
    console.log(`✨ COMPLETADO!`);
  } catch (error) {
    console.error("\n❌ ERROR:", error.message);

    // Intentar obtener logs del error
    if (error.getLogs) {
      try {
        const logs = await error.getLogs();
        console.log("\n📋 Logs detallados:");
        console.log(logs);
      } catch (e) {
        console.log("No se pudieron obtener logs detallados");
      }
    }
  }
}

executeSimpleSwap();
