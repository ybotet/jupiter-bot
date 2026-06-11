const { Connection, PublicKey } = require("@solana/web3.js");
require("dotenv/config");

const connection = new Connection("https://api.devnet.solana.com");
const publicKey = new PublicKey(process.env.DEVNET_PUBLIC_KEY);

async function checkBalance() {
  const balance = await connection.getBalance(publicKey);
  console.log(`💰 Balance de ${publicKey.toBase58()}: ${balance / 1e9} SOL`);
}

checkBalance();
