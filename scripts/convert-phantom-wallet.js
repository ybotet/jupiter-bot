// convert-wallet.js
const fs = require("fs");

// La librería bs58 debe instalarse correctamente
// Si da error, usar la implementación manual

// Función manual para decodificar base58 (sin dependencias externas)
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(input) {
  const bytes = [0];
  for (const char of input) {
    let value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) throw new Error("Invalid base58 character");

    for (let j = 0; j < bytes.length; j++) {
      value += bytes[j] * 58;
      bytes[j] = value & 0xff;
      value >>= 8;
    }
    while (value > 0) {
      bytes.push(value & 0xff);
      value >>= 8;
    }
  }

  // Remove leading zeros
  let leadingZeros = 0;
  for (const b of bytes) {
    if (b === 0) leadingZeros++;
    else break;
  }

  return bytes.slice(leadingZeros).reverse();
}

// Script principal
const readline = require("readline");
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("📝 Ingresa tu clave privada base58: ", (privateKey) => {
  try {
    const byteArray = base58Decode(privateKey.trim());

    // Verificar que sea 64 bytes
    if (byteArray.length !== 64) {
      console.error(`❌ Error: La clave tiene ${byteArray.length} bytes, debe tener 64`);
      console.log("💡 Asegúrate de copiar la clave privada COMPLETA de Phantom");
      rl.close();
      return;
    }

    // Convertir a formato JSON de Solana
    const jsonKeypair = `[${byteArray.join(",")}]`;
    fs.writeFileSync("phantom-keypair.json", jsonKeypair);

    console.log("");
    console.log("✅ Wallet convertida exitosamente!");
    console.log("📁 Archivo guardado: phantom-keypair.json");
    console.log("");
    console.log("📋 Para usar en Solana CLI:");
    console.log("   solana config set --keypair phantom-keypair.json");
    console.log("   solana address");
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.log("");
    console.log("💡 Posibles causas:");
    console.log("   1. La clave no está en formato base58");
    console.log("   2. Copiaste la dirección pública en lugar de la clave privada");
    console.log("   3. La clave tiene espacios o caracteres extra");
  }
  rl.close();
});
