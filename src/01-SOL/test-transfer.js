// test-transfer.js - Solo para probar que la wallet firma bien
require("dotenv/config");
const { Connection, Keypair, SystemProgram, Transaction } = require("@solana/web3.js");
const bs58 = require("bs58").default;

const connection = new Connection("https://api.devnet.solana.com");
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.DEVNET_PRIVATE_KEY));

async function testTransfer() {
  console.log("💰 Enviando 0.001 SOL a una dirección de prueba...");

  const testAddress = Keypair.generate().publicKey;

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: testAddress,
      lamports: 1000000, // 0.001 SOL
    }),
  );

  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  transaction.sign(wallet);

  const txid = await connection.sendRawTransaction(transaction.serialize());
  console.log(`✅ Transferencia exitosa: ${txid}`);
}

testTransfer().catch(console.error);
