const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58").default;
const fs = require("fs");

// Generar una nueva wallet
const wallet = Keypair.generate();

console.log("=".repeat(50));
console.log("🎉 WALLET CREADA EN DEVNET");
console.log("=".repeat(50));
console.log("📌 Dirección pública (Public Key):");
console.log(wallet.publicKey.toBase58());
console.log("\n🔐 Clave privada (PRIVATE KEY - GUARDALA BIEN):");
const privateKeyBase58 = bs58.encode(wallet.secretKey);
console.log(privateKeyBase58);
console.log("\n⚠️  IMPORTANTE: Esta wallet es para DEVNET (dinero falso)");
console.log("NUNCA uses estas claves en mainnet con dinero real");
console.log("=".repeat(50));

// Guardar en archivo .env (automáticamente)
const envContent = `# Archivo de configuración para Jupiter Bot
DEVNET_PRIVATE_KEY=${privateKeyBase58}
DEVNET_PUBLIC_KEY=${wallet.publicKey.toBase58()}
RPC_URL=https://api.devnet.solana.com
`;

fs.writeFileSync(".env", envContent);
console.log("\n✅ Configuración guardada en .env");
