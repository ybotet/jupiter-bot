import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { AlertManager, type AlertChannel, type AlertPayload } from '../../src/utils/alertManager';
import { createLogger, logTransactionEvent, type Logger } from '../../src/utils/logger';
import { REDACTED_PLACEHOLDER } from '../../src/utils/secrets';

/** Crea un destino de memoria que conserva cada línea JSON emitida por Pino. */
function createLogCapture(): { destination: Writable; lines: string[] } {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { destination, lines };
}

/** Crea un canal de alertas en memoria para verificar entregas sin red. */
function createAlertCapture(): { channel: AlertChannel; alerts: AlertPayload[] } {
  const alerts: AlertPayload[] = [];
  return {
    alerts,
    channel: {
      name: 'memory',
      send: async (payload) => {
        alerts.push(payload);
      },
    },
  };
}

/** Convierte las líneas capturadas en objetos JSON para facilitar las aserciones. */
function parseLogs(lines: string[]): Array<Record<string, unknown>> {
  return lines.filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

/** Crea un error con metadata sensible para comprobar la redacción del logger. */
function createSensitiveError(): Error & { secretKey: string } {
  return Object.assign(new Error('fallo simulado del bundle'), {
    secretKey: 'e2e-secret-must-not-appear',
  });
}

/** Verifica logs de éxito/fallo y alertas saneadas para una misma transacción. */
test('E2E: logging y alertas conservan contexto y no exponen secretos', async () => {
  const { destination, lines } = createLogCapture();
  const logger: Logger = createLogger({
    destination,
    level: 'debug',
    service: 'e2e-test',
  });
  const { channel, alerts } = createAlertCapture();
  const alertManager = new AlertManager({
    channels: [channel],
    logger,
    minLevel: 'info',
  });
  const transactionId = 'e2e-transaction-7-4';

  logTransactionEvent(logger, {
    status: 'started',
    transactionId,
    route: 'SOL/USDC',
    expectedProfit: '0.25',
  });
  logTransactionEvent(logger, {
    status: 'succeeded',
    transactionId,
    profit: '0.20',
    bundleId: 'bundle-success',
    durationMs: 42,
  });
  logTransactionEvent(logger, {
    status: 'failed',
    transactionId,
    error: createSensitiveError(),
    reason: 'simulated_rpc_failure',
    attempts: 2,
  });

  await alertManager.notify({
    event: 'transaction_succeeded',
    level: 'info',
    title: 'Arbitraje confirmado',
    message: 'El bundle fue confirmado en la simulación.',
    transactionId,
    metadata: { profit: '0.20', privateKey: 'e2e-secret-must-not-appear' },
  });
  await alertManager.notify({
    event: 'transaction_failed',
    level: 'error',
    title: 'Arbitraje fallido',
    message: 'El RPC simulado no respondió.',
    transactionId,
    metadata: { reason: 'simulated_rpc_failure', apiToken: 'e2e-secret-must-not-appear' },
  });

  const parsedLogs = parseLogs(lines);
  const eventMessages = parsedLogs
    .map((entry) => entry.message)
    .filter((message): message is string => typeof message === 'string');
  const transactionLogs = parsedLogs.filter(
    (entry) => typeof entry.message === 'string' && entry.message.startsWith('transaction:'),
  );
  assert.ok(eventMessages.includes('transaction:started'));
  assert.ok(eventMessages.includes('transaction:succeeded'));
  assert.ok(eventMessages.includes('transaction:failed'));
  assert.equal(transactionLogs.length, 3);
  assert.ok(transactionLogs.every((entry) => entry.transactionId === transactionId));

  const serializedLogs = lines.join('');
  assert.doesNotMatch(serializedLogs, /e2e-secret-must-not-appear/);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0]?.transactionId, transactionId);
  assert.equal(alerts[1]?.transactionId, transactionId);
  assert.equal(alerts[0]?.metadata?.privateKey, REDACTED_PLACEHOLDER);
  assert.equal(alerts[1]?.metadata?.apiToken, REDACTED_PLACEHOLDER);
});
