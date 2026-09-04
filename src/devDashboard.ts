/**
 * Launcher de desarrollo para el dashboard web (Tarea 6.2).
 *
 * Arranca el servidor Express de la Tarea 6.1 con un `InMemoryBotStatusProvider`
 * y muta sus métricas cada 3 segundos para que el frontend refleje datos
 * cambiantes durante el smoke test manual.
 *
 * NO forma parte del pipeline de producción: es una ayuda de desarrollo. El
 * launcher real del bot vive fuera de esta tarea (ver `src/index.ts`).
 *
 * Uso:
 *   npm run build            # compila TS backend a dist/
 *   npm run build:web        # compila TSX frontend a public/assets/app.js
 *   npm run serve:dashboard  # arranca el servidor en http://localhost:3001
 */
import { InMemoryBotStatusProvider, startApiServer } from './api';

async function main(): Promise<void> {
  const provider = new InMemoryBotStatusProvider({
    state: 'running',
    startedAt: new Date().toISOString(),
    cluster: process.env.SOLANA_CLUSTER ?? 'devnet',
    version: '0.0.0-dev',
  });

  const running = await startApiServer({
    statusProvider: provider,
    port: Number.parseInt(process.env.API_PORT ?? '3001', 10),
    host: process.env.API_HOST ?? '127.0.0.1',
    staticDir: process.env.API_STATIC_DIR ?? 'public',
  });

  // Feedback visible en el terminal para saber que arrancó.
  // eslint-disable-next-line no-console
  console.log(`[dev] Dashboard disponible en http://localhost:${running.port}/`);
  // eslint-disable-next-line no-console
  console.log(`[dev] API de estado en http://localhost:${running.port}/api/status`);

  // Simula actividad del bot: cada tick incrementa métricas para que el
  // dashboard muestre cambios visibles en el tablero y en el historial.
  let detected = 0;
  let submitted = 0;
  let confirmed = 0;
  let failed = 0;
  let profit = 0;

  const tick = setInterval(() => {
    detected += Math.floor(Math.random() * 3);
    submitted += Math.floor(Math.random() * 2);
    confirmed += Math.random() < 0.6 ? 1 : 0;
    failed += Math.random() < 0.2 ? 1 : 0;
    profit += Math.random() * 0.05;

    provider.mergeMetrics({
      opportunitiesDetected: detected,
      bundlesSubmitted: submitted,
      bundlesConfirmed: confirmed,
      bundlesFailed: failed,
      netProfitUsdc: profit.toFixed(4),
    });
    provider.heartbeat();
  }, 3001);

  // Cierre limpio con Ctrl+C.
  const shutdown = async (): Promise<void> => {
    clearInterval(tick);
    await running.close();
    // eslint-disable-next-line no-console
    console.log('[dev] servidor cerrado');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[dev] error al arrancar el dashboard:', err);
  process.exit(1);
});
