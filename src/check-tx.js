// check-tx.js
const { Connection, PublicKey } = require("@solana/web3.js");
require("dotenv/config");

const connection = new Connection("https://api.devnet.solana.com");
const publicKey = new PublicKey(process.env.DEVNET_PUBLIC_KEY);

async function checkRecentTransactions() {
  console.log(`🔍 Buscando transacciones recientes para ${publicKey.toBase58()}...`);

  try {
    // Obtener las últimas transacciones firmadas por esta wallet
    const signatures = await connection.getSignaturesForAddress(publicKey, { limit: 5 });

    if (signatures.length === 0) {
      console.log("❌ No se encontraron transacciones recientes.");
      console.log("💡 El faucet web pudo haber fallado silenciosamente.");
      console.log("💡 Solución: Usa el comando 'solana airdrop 2' desde CLI");
      return;
    }

    console.log(`✅ Encontradas ${signatures.length} transacciones:`);
    signatures.forEach((sig, i) => {
      console.log(`${i + 1}. ${sig.signature} - ${sig.confirmationStatus} - ${sig.slot}`);
    });

    // Verificar el balance nuevamente
    const balance = await connection.getBalance(publicKey);
    console.log(`\n💰 Balance final: ${balance / 1e9} SOL`);
  } catch (error) {
    console.error("Error al consultar:", error.message);
  }
}

checkRecentTransactions();
