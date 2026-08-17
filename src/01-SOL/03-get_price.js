async function testConnectivity() {
  console.log("🔍 Probando conectividad con Jupiter...");

  //   try {
  //#region Test 0: Price API
  const response = await fetch(
    "https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112",
    {
      headers: { "x-api-key": process.env.JUPITER_API_KEY || "" },
    },
  );
  const data = await response.json();
  console.log(`data: ${JSON.stringify(data)} `);
  //#endregion

  //#region Test 1: Tokens API
  console.log("📡 Test endpoint...");
  const response2 = await fetch("https://lite-api.jup.ag/tokens/v2/search?query=JUP", {
    headers: {
      "x-api-key": process.env.JUPITER_API_KEY || "",
    },
  });
  if (!response2.ok) {
    console.log(`HTTP ${response2.status}: ${response2.statusText}`);
  }
  const tokens = await response2.json();
  console.log(`✅ Endpoint OK`);
  console.log(`   Respuesta: ${Object.keys(tokens).join(", ")}`);
  //#endregion
}
testConnectivity();
