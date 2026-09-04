/**
 * Pruebas unitarias de aceptación para el logger estructurado.
 *
 * Cumple con el criterio de la Tarea 5.4: "Las pruebas validan la estructura
 * del log". Usa mocks explícitos para:
 *   - Reemplazar el destino de escritura por un `Writable` en memoria.
 *   - Suplantar el proveedor de secretos por uno inyectado en memoria.
 * Con esto no se toca el filesystem ni `process.env` en las aserciones.
 */

import { strict as assert } from 'node:assert';
import { Writable } from 'node:stream';
import test from 'node:test';

import {
  DEFAULT_SERVICE_NAME,
  createLogger,
  logTransactionEvent,
  resolveLoggerConfigFromEnv,
  serializeError,
  withTransactionContext,
} from '../src/utils/logger';
import type { SecretsProvider } from '../src/utils/secrets';
import { REDACTED_PLACEHOLDER } from '../src/utils/secrets';

/**
 * Crea un `Writable` en memoria que actúa como mock del destino del logger.
 * Cada línea escrita se parsea como JSON y se acumula para las aserciones.
 */
function createCapture(): { stream: Writable; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, cb): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }
        entries.push(JSON.parse(trimmed) as Record<string, unknown>);
      }
      cb();
    },
  });
  return { stream, entries };
}

/**
 * Construye un `SecretsProvider` mock alimentado con un objeto plano en
 * memoria. Se usa para simular las variables de entorno relevantes del
 * logger sin tocar `process.env`.
 */
function memoryProvider(values: Record<string, string | undefined>): SecretsProvider {
  return {
    getSecret(name: string): string | undefined {
      return values[name];
    },
  };
}

test('estructura del log: JSON con time ISO, level textual, message y service base', () => {
  const capture = createCapture();
  const logger = createLogger({ destination: capture.stream, level: 'debug' });

  logger.info({ transactionId: 'tx-001', pair: 'SOL/USDC' }, 'oportunidad detectada');

  assert.equal(capture.entries.length, 1);
  const entry = capture.entries[0];
  assert.equal(entry.level, 'info');
  assert.equal(entry.message, 'oportunidad detectada');
  assert.equal(entry.transactionId, 'tx-001');
  assert.equal(entry.pair, 'SOL/USDC');
  assert.equal(entry.service, DEFAULT_SERVICE_NAME);
  assert.equal(typeof entry.time, 'string');
  assert.ok(
    !Number.isNaN(Date.parse(entry.time as string)),
    'el campo time debe ser una fecha ISO parseable',
  );
});

test('estructura del log: respeta el nivel mínimo configurado y descarta las entradas inferiores', () => {
  const capture = createCapture();
  const logger = createLogger({ destination: capture.stream, level: 'warn' });

  logger.debug('debe ser descartado');
  logger.info('debe ser descartado');
  logger.warn('emitido');
  logger.error('emitido');

  assert.equal(capture.entries.length, 2);
  assert.deepEqual(
    capture.entries.map((entry) => entry.level),
    ['warn', 'error'],
  );
});

test('estructura del log: redacta campos sensibles superficiales y anidados antes de escribir', () => {
  const capture = createCapture();
  const logger = createLogger({ destination: capture.stream });

  logger.info(
    {
      privateKey: 'no-debe-aparecer',
      wallet: { secretKey: 'tampoco', publicKey: 'PubKeyOk' },
      headers: { authorization: 'Bearer super-secret' },
    },
    'firmando bundle',
  );

  const entry = capture.entries[0];
  const wallet = entry.wallet as Record<string, unknown>;
  const headers = entry.headers as Record<string, unknown>;
  assert.equal(entry.privateKey, REDACTED_PLACEHOLDER);
  assert.equal(wallet.secretKey, REDACTED_PLACEHOLDER);
  assert.equal(wallet.publicKey, 'PubKeyOk');
  assert.equal(headers.authorization, REDACTED_PLACEHOLDER);
});

test('withTransactionContext propaga transactionId y campos extra a toda línea derivada', () => {
  const capture = createCapture();
  const logger = createLogger({ destination: capture.stream });

  const scoped = withTransactionContext(logger, 'tx-777', {
    route: 'SOL->USDC->SOL',
    pair: 'SOL/USDC',
  });
  scoped.info('inicio bundle');
  scoped.warn('reintento');

  assert.equal(capture.entries.length, 2);
  for (const entry of capture.entries) {
    assert.equal(entry.transactionId, 'tx-777');
    assert.equal(entry.route, 'SOL->USDC->SOL');
    assert.equal(entry.pair, 'SOL/USDC');
  }
});

test('withTransactionContext rechaza transactionId vacío o solo espacios', () => {
  const capture = createCapture();
  const logger = createLogger({ destination: capture.stream });
  assert.throws(() => withTransactionContext(logger, ''), /transactionId es obligatorio/);
  assert.throws(() => withTransactionContext(logger, '   '), /transactionId es obligatorio/);
});

test('logTransactionEvent emite transaction:started con expectedProfit', () => {
  const capture = createCapture();
  const logger = createLogger({ destination: capture.stream });

  logTransactionEvent(logger, {
    status: 'started',
    transactionId: 'tx-100',
    expectedProfit: '0.42',
  });

  const entry = capture.entries[0];
  assert.equal(entry.level, 'info');
  assert.equal(entry.message, 'transaction:started');
  assert.equal(entry.transactionId, 'tx-100');
  assert.equal(entry.expectedProfit, '0.42');
});

test('logTransactionEvent emite transaction:succeeded con el profit exigido por el criterio 5.2', () => {
  const capture = createCapture();
  const logger = createLogger({ destination: capture.stream });

  logTransactionEvent(logger, {
    status: 'succeeded',
    transactionId: 'tx-101',
    profit: 1.75,
    signatures: ['sig-1'],
    slot: 999_999,
    bundleId: 'bundle-xyz',
    durationMs: 620,
  });

  const entry = capture.entries[0];
  assert.equal(entry.level, 'info');
  assert.equal(entry.message, 'transaction:succeeded');
  assert.equal(entry.transactionId, 'tx-101');
  assert.equal(entry.profit, 1.75);
  assert.deepEqual(entry.signatures, ['sig-1']);
  assert.equal(entry.slot, 999_999);
  assert.equal(entry.bundleId, 'bundle-xyz');
  assert.equal(entry.durationMs, 620);
});

test('logTransactionEvent emite transaction:failed con err serializado y no expone secretos anexados', () => {
  const capture = createCapture();
  const logger = createLogger({ destination: capture.stream });

  const rootCause = new Error('rpc caído');
  const wrapped = new Error('fallo enviando bundle', { cause: rootCause }) as Error & {
    secretKey?: string;
  };
  wrapped.secretKey = 'no-debe-aparecer';

  logTransactionEvent(logger, {
    status: 'failed',
    transactionId: 'tx-102',
    error: wrapped,
    reason: 'simulationFailure',
    attempts: 5,
    bundleId: 'bundle-abc',
    durationMs: 1200,
  });

  const entry = capture.entries[0];
  assert.equal(entry.level, 'warn');
  assert.equal(entry.message, 'transaction:failed');
  assert.equal(entry.transactionId, 'tx-102');
  assert.equal(entry.reason, 'simulationFailure');
  assert.equal(entry.attempts, 5);
  assert.equal(entry.bundleId, 'bundle-abc');

  const err = entry.err as Record<string, unknown>;
  assert.ok(err, 'el evento failed debe incluir el campo err serializado');
  assert.equal(err.type, 'Error');
  assert.equal(err.message, 'fallo enviando bundle');
  assert.equal(err.secretKey, REDACTED_PLACEHOLDER);
  const cause = err.cause as Record<string, unknown>;
  assert.ok(cause);
  assert.equal(cause.message, 'rpc caído');

  const serialized = JSON.stringify(entry);
  assert.ok(
    !serialized.includes('no-debe-aparecer'),
    'ningún secreto anexado al Error debe filtrarse al log',
  );
});

test('serializeError normaliza strings, objetos, null y primitivos', () => {
  assert.deepEqual(serializeError('boom'), { type: 'String', message: 'boom' });
  assert.deepEqual(serializeError({ code: 42, details: 'x' }), {
    type: 'Object',
    code: 42,
    details: 'x',
  });
  assert.deepEqual(serializeError(null), { type: 'object', message: 'null' });
  assert.deepEqual(serializeError(undefined), { type: 'undefined', message: 'undefined' });
});

test('resolveLoggerConfigFromEnv usa el provider mockeado y respeta valores válidos', () => {
  const provider = memoryProvider({
    LOG_LEVEL: 'debug',
    LOG_FILE_PATH: 'logs/custom.log',
    LOG_SERVICE_NAME: 'mev-bot-test',
    LOG_ROTATION_FREQUENCY: 'hourly',
    LOG_ROTATION_SIZE: '5m',
    LOG_ROTATION_LIMIT: '3',
  });

  const config = resolveLoggerConfigFromEnv(provider);

  assert.equal(config.level, 'debug');
  assert.equal(config.filePath, 'logs/custom.log');
  assert.equal(config.service, 'mev-bot-test');
  assert.equal(config.rotation.frequency, 'hourly');
  assert.equal(config.rotation.size, '5m');
  assert.equal(config.rotation.limit, 3);
});

test('resolveLoggerConfigFromEnv ignora LOG_LEVEL inválido y cae al default info', () => {
  const config = resolveLoggerConfigFromEnv(memoryProvider({ LOG_LEVEL: 'verbose' }));
  assert.equal(config.level, 'info');
});

