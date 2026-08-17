// test-dns-telegram.js
async function testDNS() {
  console.log("🔍 Probando resolución DNS para Telegram...");

  try {
    // 1. Probar DNS
    const dnsLookup = await fetch("https://api.telegram.org");
    console.log(`✅ DNS: api.telegram.org resuelve (status: ${dnsLookup.status})`);

    // 2. Probar con IP directa (si el DNS falla)
    console.log("📡 Probando con IP directa...");
    const ipResponse = await fetch("https://149.154.167.99", {
      headers: { Host: "api.telegram.org" },
    });
    console.log(`✅ IP directa: ${ipResponse.status}`);
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.log("\n💡 Soluciones:");
    console.log("   1. Cambia tu DNS a 1.1.1.1 o 8.8.8.8");
    console.log("   2. Reinicia tu router/modem");
    console.log("   3. Si usas VPN, desconéctala temporalmente");
    console.log("   4. Usa un proxy o red diferente");
  }
}

testDNS();
