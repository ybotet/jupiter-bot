// price-alert-telegram.js - Alertador con Telegram
require("dotenv/config");
const fs = require("fs");

// ============================================
// CONFIGURACIÓN DE TELEGRAM
// ============================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Reemplaza con tu token
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // Reemplaza con tu chat ID

// ============================================
// CONFIGURACIÓN DE MONITOREO
// ============================================
const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

const MONITOR_INTERVAL = 10000; // 10 segundos

// 🔥 UMBRALES DE ALERTA
const THRESHOLDS = {
  BUY_IF_BELOW: 77.9, // Comprar si SOL baja de 77.90 USDC
  SELL_IF_ABOVE: 78.05, // Vender si SOL sube de 78.05 USDC
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
// FUNCIÓN PARA ENVIAR MENSAJE A TELEGRAM
// ============================================
async function sendTelegramMessage(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Error enviando a Telegram: ${errorText}`);
    } else {
      console.log("✅ Notificación enviada a Telegram");
    }
  } catch (error) {
    console.error(`❌ Error en Telegram: ${error.message}`);
  }
}

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
  fs.appendFileSync("alerts-history.csv", logLine);
}

// ============================================
// FUNCIÓN PRINCIPAL DE MONITOREO
// ============================================
async function monitorPrices() {
  console.log("\n🔔 INICIANDO ALERTADOR CON TELEGRAM");
  console.log("=".repeat(60));
  console.log(`📱 Notificaciones enviadas a Telegram`);
  console.log(`⏱️  Intervalo: ${MONITOR_INTERVAL / 1000} segundos`);
  console.log(`📉 Alerta COMPRA si SOL < ${THRESHOLDS.BUY_IF_BELOW} USDC`);
  console.log(`📈 Alerta VENTA si SOL > ${THRESHOLDS.SELL_IF_ABOVE} USDC`);
  console.log(`📊 Alerta cambio > ${THRESHOLDS.PRICE_CHANGE_ALERT}%`);
  console.log("=".repeat(60));
  console.log("🔍 Monitorizando... (Presiona Ctrl+C para detener)\n");

  // Enviar mensaje de inicio
  await sendTelegramMessage(
    "🚀 *Bot de Monitoreo Iniciado*\n\n📊 Monitorizando precio de SOL/USDC",
  );

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
      // EVALUAR ALERTAS
      // ============================================
      let alerts = [];

      // Alerta 1: Precio de compra
      if (price < THRESHOLDS.BUY_IF_BELOW && !alertState.buyTriggered) {
        const message = `🔔 *¡ALERTA DE COMPRA!*\n\n💰 Precio: ${price.toFixed(4)} USDC/SOL\n📉 Umbral: ${THRESHOLDS.BUY_IF_BELOW} USDC\n🕐 Hora: ${timestamp}\n🗺️ Ruta: ${route}`;
        alerts.push({ type: "BUY", message });
        alertState.buyTriggered = true;
        saveAlert("BUY", price, message);
        await sendTelegramMessage(message);
      }

      // Alerta 2: Precio de venta
      if (price > THRESHOLDS.SELL_IF_ABOVE && !alertState.sellTriggered) {
        const message = `🔔 *¡ALERTA DE VENTA!*\n\n💰 Precio: ${price.toFixed(4)} USDC/SOL\n📈 Umbral: ${THRESHOLDS.SELL_IF_ABOVE} USDC\n🕐 Hora: ${timestamp}\n🗺️ Ruta: ${route}`;
        alerts.push({ type: "SELL", message });
        alertState.sellTriggered = true;
        saveAlert("SELL", price, message);
        await sendTelegramMessage(message);
      }

      // Alerta 3: Cambio porcentual significativo
      if (Math.abs(change) > THRESHOLDS.PRICE_CHANGE_ALERT) {
        const direction = change > 0 ? "⬆️ subió" : "⬇️ bajó";
        const message = `📊 *Cambio Significativo*\n\n💰 Precio: ${price.toFixed(4)} USDC/SOL\n📊 ${direction} un ${Math.abs(change).toFixed(2)}%\n🕐 Hora: ${timestamp}`;
        alerts.push({ type: "CHANGE", message });
        saveAlert("CHANGE", price, message);
        await sendTelegramMessage(message);
      }

      // ============================================
      // MOSTRAR RESULTADOS EN CONSOLA
      // ============================================
      console.log(
        `[${timestamp}] 📡 #${quoteCount} | Precio: ${price.toFixed(4)} USDC | Cambio: ${change >= 0 ? "+" : ""}${change.toFixed(4)}%`,
      );
      console.log(`   🗺️  Ruta: ${route}`);

      if (alerts.length > 0) {
        console.log(`   📱 Notificaciones enviadas: ${alerts.length}`);
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
      await sendTelegramMessage(`⚠️ *Error en el bot:*\n${error.message}`);
      console.log("⏳ Reintentando en 5 segundos...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// ============================================
// MANEJAR CIERRE GRACIAL
// ============================================
process.on("SIGINT", async () => {
  console.log("\n\n🛑 Monitor detenido por el usuario.");
  await sendTelegramMessage("🛑 *Bot de Monitoreo Detenido*\n\n📊 Historial de alertas guardado.");
  process.exit(0);
});

// ============================================
// EJECUTAR
// ============================================
monitorPrices();
