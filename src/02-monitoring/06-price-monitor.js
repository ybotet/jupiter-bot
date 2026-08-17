// price-monitor.js - Monitoreo continuo de precios
require("dotenv/config");

// ============================================
// CONFIGURACIÓN
// ============================================
const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

// Intervalo de monitoreo (en milisegundos)
const MONITOR_INTERVAL = 10000; // 10 segundos

// Umbrales para alertas
const ALERT_THRESHOLDS = {
  SOL_USD: 75.0, // Alertar si SOL > 75 USDC
  PRICE_CHANGE: 0.5, // Alertar si el precio cambia > 0.5%
};

// ============================================
// FUNCIÓN PARA OBTENER UN QUOTE
// ============================================
async function getQuote(inputMint, outputMint, amount = 0.01 * 1e9) {
  const quoteUrl = `${process.env.QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=100`;

  try {
    const response = await fetch(quoteUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const quote = await response.json();
    return quote;
  } catch (error) {
    console.error(`❌ Error en quote: ${error.message}`);
    return null;
  }
}

// ============================================
// FUNCIÓN PARA CALCULAR CAMBIO DE PRECIO
// ============================================
function calculatePriceChange(currentPrice, previousPrice) {
  if (!previousPrice) return 0;
  return ((currentPrice - previousPrice) / previousPrice) * 100;
}

// ============================================
// FUNCIÓN PRINCIPAL DE MONITOREO
// ============================================
async function monitorPrices() {
  console.log("\n📊 INICIANDO MONITOREO CONTINUO");
  console.log("=".repeat(60));
  console.log(`⏱️  Intervalo: ${MONITOR_INTERVAL / 1000} segundos`);
  console.log(`🔔 Alerta SOL > ${ALERT_THRESHOLDS.SOL_USD} USDC`);
  console.log(`🔔 Alerta cambio > ${ALERT_THRESHOLDS.PRICE_CHANGE}%`);
  console.log("=".repeat(60));

  let previousPrice = null;
  let quoteCount = 0;

  while (true) {
    try {
      quoteCount++;
      const timestamp = new Date().toLocaleTimeString();

      // Obtener quote
      console.log(`\n[${timestamp}] 📡 Consulta #${quoteCount}...`);
      const quote = await getQuote(TOKENS.SOL, TOKENS.USDC);

      if (!quote || !quote.outAmount) {
        console.log("⚠️ No se pudo obtener quote. Reintentando...");
        await new Promise((resolve) => setTimeout(resolve, MONITOR_INTERVAL));
        continue;
      }

      // Calcular precio
      const amount = 0.01 * 1e9;
      const price = quote.outAmount / 1e6 / (amount / 1e9);
      const impact = parseFloat(quote.priceImpactPct);
      const route = quote.routePlan.map((r) => r.swapInfo.label).join(" → ");

      // Mostrar resultado
      console.log(`💰 Precio: ${price.toFixed(4)} USDC/SOL`);
      console.log(`📉 Impacto: ${impact.toFixed(6)}%`);
      console.log(`🗺️  Ruta: ${route}`);

      // Calcular cambio de precio
      if (previousPrice !== null) {
        const change = calculatePriceChange(price, previousPrice);
        console.log(`📊 Cambio: ${change >= 0 ? "+" : ""}${change.toFixed(4)}%`);

        // Alertas
        if (Math.abs(change) > ALERT_THRESHOLDS.PRICE_CHANGE) {
          console.log(`🔔 ALERTA: Cambio de precio > ${ALERT_THRESHOLDS.PRICE_CHANGE}%`);
        }
      }

      // Alerta de precio alto
      if (price > ALERT_THRESHOLDS.SOL_USD) {
        console.log(`🔔 ALERTA: SOL > ${ALERT_THRESHOLDS.SOL_USD} USDC`);
      }

      previousPrice = price;

      // Esperar antes de la siguiente consulta
      console.log(`\n⏳ Esperando ${MONITOR_INTERVAL / 1000} segundos...`);
      await new Promise((resolve) => setTimeout(resolve, MONITOR_INTERVAL));
    } catch (error) {
      console.error(`❌ Error en monitoreo: ${error.message}`);
      console.log("⏳ Reintentando en 5 segundos...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// ============================================
// EJECUTAR
// ============================================
monitorPrices();
