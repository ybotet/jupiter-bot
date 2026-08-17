// price-alert.js - Alertador de precios
require("dotenv/config");
const fs = require("fs");

// ============================================
// CONFIGURACIÓN
// ============================================
const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

const MONITOR_INTERVAL = 10000; // 10 segundos

// 🔥 UMBRALES DE ALERTA
const THRESHOLDS = {
  // Umbrales de precio
  BUY_IF_BELOW: 77.9, // Comprar si SOL baja de 77.90 USDC
  SELL_IF_ABOVE: 78.05, // Vender si SOL sube de 78.05 USDC

  // Umbral de cambio porcentual
  PRICE_CHANGE_ALERT: 0.5, // Alertar si cambia > 0.5%
};

// Estados para evitar alertas repetidas
let alertState = {
  buyTriggered: false,
  sellTriggered: false,
  lastPrice: null,
  lastAlertTime: null,
};

// ============================================
// FUNCIÓN PARA OBTENER QUOTE
// ============================================
async function getQuote(inputMint, outputMint, amount = 0.01 * 1e9) {
  const quoteUrl = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=100`;

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
// FUNCIÓN PARA GUARDAR ALERTAS
// ============================================
function saveAlert(type, price, message) {
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp},${type},${price},${message}\n`;

  // Guardar en archivo CSV
  fs.appendFileSync("alerts-history.csv", logLine);

  // También guardar en un archivo de log legible
  const logEntry = `[${new Date().toLocaleString()}] ${type}: ${message}\n`;
  fs.appendFileSync("alerts.log", logEntry);
}

// ============================================
// FUNCIÓN PRINCIPAL DE MONITOREO
// ============================================
async function monitorPrices() {
  console.log("\n🔔 INICIANDO ALERTADOR DE PRECIOS");
  console.log("=".repeat(60));
  console.log(`⏱️  Intervalo: ${MONITOR_INTERVAL / 1000} segundos`);
  console.log(`📉 Alerta COMPRA si SOL < ${THRESHOLDS.BUY_IF_BELOW} USDC`);
  console.log(`📈 Alerta VENTA si SOL > ${THRESHOLDS.SELL_IF_ABOVE} USDC`);
  console.log(`📊 Alerta cambio > ${THRESHOLDS.PRICE_CHANGE_ALERT}%`);
  console.log("=".repeat(60));
  console.log("🔍 Monitorizando... (Presiona Ctrl+C para detener)\n");

  let quoteCount = 0;

  while (true) {
    try {
      quoteCount++;
      const timestamp = new Date().toLocaleTimeString();

      // Obtener quote
      const quote = await getQuote(TOKENS.SOL, TOKENS.USDC);

      if (!quote || !quote.outAmount) {
        console.log("⚠️ No se pudo obtener quote. Reintentando...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      // Calcular precio
      const amount = 0.01 * 1e9;
      const price = quote.outAmount / 1e6 / (amount / 1e9);
      const impact = parseFloat(quote.priceImpactPct);
      const route = quote.routePlan.map((r) => r.swapInfo.label).join(" → ");

      // Calcular cambio de precio
      let change = 0;
      if (alertState.lastPrice !== null) {
        change = ((price - alertState.lastPrice) / alertState.lastPrice) * 100;
      }

      // ============================================
      // 🔥 EVALUAR ALERTAS
      // ============================================
      let alerts = [];

      // Alerta 1: Precio de compra
      if (price < THRESHOLDS.BUY_IF_BELOW && !alertState.buyTriggered) {
        const message = `🔔 COMPRA: SOL bajó a ${price.toFixed(4)} USDC (umbral: ${THRESHOLDS.BUY_IF_BELOW})`;
        alerts.push({ type: "BUY", message });
        alertState.buyTriggered = true;
        saveAlert("BUY", price, message);
      }

      // Alerta 2: Precio de venta
      if (price > THRESHOLDS.SELL_IF_ABOVE && !alertState.sellTriggered) {
        const message = `🔔 VENTA: SOL subió a ${price.toFixed(4)} USDC (umbral: ${THRESHOLDS.SELL_IF_ABOVE})`;
        alerts.push({ type: "SELL", message });
        alertState.sellTriggered = true;
        saveAlert("SELL", price, message);
      }

      // Alerta 3: Cambio porcentual significativo
      if (Math.abs(change) > THRESHOLDS.PRICE_CHANGE_ALERT) {
        const direction = change > 0 ? "subió" : "bajó";
        const message = `📊 Cambio: SOL ${direction} ${Math.abs(change).toFixed(2)}% (${price.toFixed(4)} USDC)`;
        alerts.push({ type: "CHANGE", message });
        saveAlert("CHANGE", price, message);
      }

      // ============================================
      // MOSTRAR RESULTADOS
      // ============================================
      console.log(
        `[${timestamp}] 📡 #${quoteCount} | Precio: ${price.toFixed(4)} USDC | Cambio: ${change >= 0 ? "+" : ""}${change.toFixed(4)}%`,
      );
      console.log(`   🗺️  Ruta: ${route}`);

      // Mostrar alertas
      if (alerts.length > 0) {
        console.log("   " + "=".repeat(40));
        alerts.forEach((alert) => {
          console.log(`   ${alert.message}`);
        });
        console.log("   " + "=".repeat(40));
      }

      // ============================================
      // RESETEAR ESTADOS SI EL PRECIO VUELVE A LA NORMALIDAD
      // ============================================
      if (price >= THRESHOLDS.BUY_IF_BELOW) {
        alertState.buyTriggered = false;
      }
      if (price <= THRESHOLDS.SELL_IF_ABOVE) {
        alertState.sellTriggered = false;
      }

      // Actualizar estado
      alertState.lastPrice = price;

      // Esperar antes de la siguiente consulta
      await new Promise((resolve) => setTimeout(resolve, MONITOR_INTERVAL));
    } catch (error) {
      console.error(`❌ Error en monitoreo: ${error.message}`);
      console.log("⏳ Reintentando en 5 segundos...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// ============================================
// MANEJAR CIERRE GRACIAL
// ============================================
process.on("SIGINT", () => {
  console.log("\n\n🛑 Monitor detenido por el usuario.");
  console.log("📊 Historial de alertas guardado en alerts-history.csv");
  process.exit(0);
});

// ============================================
// EJECUTAR
// ============================================
monitorPrices();
