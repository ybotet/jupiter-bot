// swap-sdk.js - Usando el SDK oficial (RECOMENDADO)
require("dotenv/config");
const { createJupiterApiClient } = require("@jup-ag/api");
const { Connection, Keypair, VersionedTransaction } = require("@solana/web3.js");
const bs58 = require("bs58").default;

// Configurar el cliente de Jupiter con el endpoint público
const jupiterApi = createJupiterApiClient({
  basePath: "https://public.jupiterapi.com", // 🔥 Endpoint público correcto
});

const connection = new Connection("https://api.devnet.solana.com");
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.DEVNET_PRIVATE_KEY));

const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

async function swap() {
  console.log("\n🚀 SWAP CON SDK OFICIAL");
  console.log("=".repeat(50));

  try {
    const balance = await connection.getBalance(wallet.publicKey);
    console.log(`💰 Balance: ${balance / 1e9} SOL`);

    const amount = 0.01 * 1e9;

    // Usar el SDK en lugar de fetch manual
    console.log("📡 Obteniendo quote...");
    const quote = await jupiterApi.quoteGet({
      inputMint: TOKENS.SOL,
      outputMint: TOKENS.USDC,
      amount: amount,
      slippageBps: 100,
    });

    if (!quote.outAmount) {
      console.log("❌ No hay liquidez en Devnet");
      return;
    }

    console.log(`✅ Recibirás: ${quote.outAmount / 1e6} USDC`);

    console.log("🔨 Construyendo transacción...");
    const { swapTransaction } = await jupiterApi.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      },
    });

    const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    transaction.sign([wallet]);

    console.log("📡 Enviando...");
    const txid = await connection.sendRawTransaction(transaction.serialize());
    console.log(`✅ Tx: https://explorer.solana.com/tx/${txid}?cluster=devnet`);
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

swap();
