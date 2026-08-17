require("dotenv/config");
const { Connection, PublicKey } = require("@solana/web3.js");

// ============================================
// CONFIGURACIÓN
// ============================================
const connection = new Connection("https://api.devnet.solana.com");

// Direcciones de los tokens (Mints)
const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
};

// ============================================
// FUNCIÓN PRINCIPAL: OBTENER QUOTE
// ============================================
async function getQuote(inputMint, outputMint, amount, slippageBps = 100) {
  console.log("\n" + "=".repeat(60));
  console.log("📊 SOLICITANDO QUOTE (COTIZACIÓN)");
  console.log("=".repeat(60));

  // 1. Mostrar parámetros de entrada
  console.log(`\n🔍 Parámetros:`);
  console.log(`   - De: ${inputMint === TOKENS.SOL ? "SOL" : inputMint}`);
  console.log(`   - A: ${outputMint === TOKENS.USDC ? "USDC" : outputMint}`);
  console.log(`   - Cantidad: ${amount / 1e9} SOL (${amount} lamports)`);
  console.log(`   - Slippage: ${slippageBps / 100}%`);

  try {
    // 2. Construir la URL para el quote
    const quoteUrl = `${process.env.QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;

    console.log(`\n📡 Consultando Jupiter API...`);
    console.log(`   URL: ${quoteUrl.replace(/&/g, "\n        &")}`); // Muestra la URL formateada

    // 3. Hacer la petición
    const startTime = Date.now();
    const response = await fetch(quoteUrl);
    const elapsedTime = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Error HTTP ${response.status}: ${errorText}`);
    }

    const quote = await response.json();
    console.log(`✅ Respuesta recibida en ${elapsedTime}ms`);

    // 4. Verificar si hay ruta disponible
    if (!quote.outAmount) {
      console.log("\n❌ No se encontró una ruta de swap disponible.");
      console.log("💡 Esto puede deberse a:");
      console.log("   - Falta de liquidez en el par de tokens");
      console.log("   - El token destino no tiene mercado en Devnet");
      console.log("   - El monto es demasiado pequeño");
      return null;
    }

    // 5. Mostrar resultados principales
    console.log("\n📊 RESULTADO DEL QUOTE:");
    console.log("=".repeat(40));
    console.log(`💰 Recibirás: ${quote.outAmount / 1e6} USDC`);
    console.log(`📉 Impacto en precio: ${quote.priceImpactPct}%`);
    console.log(`💱 Precio efectivo: 1 SOL = ${quote.outAmount / 1e6 / (amount / 1e9)} USDC`);

    // 6. Mostrar la ruta detallada
    console.log("\n🗺️  RUTA DE INTERCAMBIO:");
    console.log("-".repeat(40));
    quote.routePlan.forEach((step, index) => {
      const swapInfo = step.swapInfo;
      console.log(`   Paso ${index + 1}: ${swapInfo.label}`);
      console.log(`      - DEX: ${swapInfo.ammKey || "Desconocido"}`);
      console.log(`      - Entrada: ${swapInfo.inputMint}`);
      console.log(`      - Salida: ${swapInfo.outputMint}`);
    });

    // 7. Mostrar otros detalles útiles
    console.log("\n📋 OTROS DETALLES:");
    console.log("-".repeat(40));
    console.log(`   - ID de la ruta: ${quote.routeId || "N/A"}`);
    console.log(`   - Precio sin slippage: ${quote.otherAmountThreshold || "N/A"}`);
    console.log(`   - Contexto: ${quote.contextSlot ? `Slot ${quote.contextSlot}` : "N/A"}`);

    // 8. Mostrar resumen en una línea
    console.log("\n" + "=".repeat(60));
    console.log(`✅ QUOTE COMPLETADO: ${amount / 1e9} SOL → ${quote.outAmount / 1e6} USDC`);
    console.log(`   Precio: ${quote.outAmount / 1e6 / (amount / 1e9)} USDC/SOL`);
    console.log(`   Impacto: ${quote.priceImpactPct}%`);
    console.log("=".repeat(60));

    return quote;
  } catch (error) {
    console.error("\n❌ ERROR AL OBTENER QUOTE:", error.message);
    if (error.message.includes("fetch")) {
      console.log("💡 Verifica tu conexión a internet.");
    }
    return null;
  }
}

// ============================================
// BLOQUE DE PRUEBAS
// ============================================
async function runTests() {
  console.log("\n🧪 INICIANDO PRUEBAS DE QUOTE");
  console.log("=".repeat(60));

  // Prueba 1: Swap de SOL a USDC
  console.log("\n📌 Prueba 1: SOL → USDC");
  await getQuote(TOKENS.SOL, TOKENS.USDC, 0.01 * 1e9);

  // Prueba 2: Swap de SOL a BONK
  console.log("\n📌 Prueba 2: SOL → BONK");
  await getQuote(TOKENS.SOL, TOKENS.BONK, 0.01 * 1e9);

  // Prueba 3: Swap de SOL a USDC con mayor slippage
  console.log("\n📌 Prueba 3: SOL → USDC (slippage 5%)");
  await getQuote(TOKENS.SOL, TOKENS.USDC, 0.01 * 1e9, 500);

  // Prueba 4: Swap de SOL a USDC con monto mayor
  console.log("\n📌 Prueba 4: SOL → USDC (0.1 SOL)");
  await getQuote(TOKENS.SOL, TOKENS.USDC, 0.1 * 1e9);
}

// ============================================
// EJECUTAR (descomenta la que quieras)
// ============================================

// Opción 1: Ejecutar una sola prueba
// getQuote(TOKENS.SOL, TOKENS.USDC, 0.01 * 1e9);

// Opción 2: Ejecutar todas las pruebas
runTests();
