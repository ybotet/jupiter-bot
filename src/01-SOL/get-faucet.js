const { Connection, PublicKey } = require("@solana/web3.js");
require("dotenv/config");

const connection = new Connection("https://api.devnet.solana.com");
const publicKey = new PublicKey(process.env.DEVNET_PUBLIC_KEY);

async function requestAirdrop() {
  console.log("🚰 Solicitando SOL del faucet...");

  try {
    // Pedir 2 SOL (el máximo por request es ~5 SOL)
    const signature = await connection.requestAirdrop(
      publicKey,
      2 * 1e9, // 2 SOL en lamports
    );

    console.log(`✅ Transacción enviada: ${signature}`);

    // Esperar confirmación
    await connection.confirmTransaction(signature);

    // Verificar balance
    const balance = await connection.getBalance(publicKey);
    console.log(`💰 Balance actual: ${balance / 1e9} SOL`);
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.log("💡 Alternativa: Usa https://faucet.solana.com/");
  }
}

requestAirdrop();
