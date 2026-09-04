import { strict as assert } from 'node:assert';
import { Writable } from 'node:stream';
import { after, describe, it } from 'node:test';

import {
  DEFAULT_SERVICE_NAME,
  createLogger,
  logTransactionEvent,
  resolveLoggerConfigFromEnv,
  serializeError,
  withTransactionContext,
} from './logger';
import type { SecretsProvider } from './secrets';
import { REDACTED_PLACEHOLDER } from './secrets';

/**
 * Crea un stream de captura en memoria. Cada línea escrita se parsea como
 * JSON y se acumula para que las aserciones puedan inspeccionarla.
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
 * Construye un `SecretsProvider` en memoria para las pruebas que necesitan
 * simular valores concretos en variables de entorno sin tocar `process.env`.
 */
function memoryProvider(values: Record<string, string | undefined>): SecretsProvider {
  return {
    getSecret(name: string): string | undefined {
      return values[name];
    },
  };
}

describe('createLogger', () => {
  const originalCwd = process.cwd();
  after(() => {
    process.chdir(originalCwd);
  });

  it('emite entradas JSON con timestamp ISO, nivel textual y campo message', () => {
    const capture = createCapture();
    const logger = createLogger({ destination: capture.stream, level: 'debug' });

    logger.info({ transactionId: 'tx-1' }, 'inicio de arbitraje');

    assert.equal(capture.entries.length, 1);
    const entry = capture.entries[0];
    assert.equal(entry.level, 'info');
    assert.equal(entry.message, 'inicio de arbitraje');
    assert.equal(entry.transactionId, 'tx-1');
    assert.equal(typeof entry.time, 'string');
    assert.ok(!Number.isNaN(Date.parse(entry.time as string)), 'time debe ser ISO parseable');
    assert.equal(entry.service, DEFAULT_SERVICE_NAME);
  });

  it('respeta el nivel mínimo configurado', () => {
    const capture = createCapture();
    const logger = createLogger({ destination: capture.stream, level: 'warn' });

    logger.debug('descartado por nivel');
    logger.info('descartado por nivel');
    logger.warn('emitido');
    logger.error('emitido');

    assert.equal(capture.entries.length, 2);
    assert.deepEqual(
      capture.entries.map((entry) => entry.level),
      ['warn', 'error'],
    );
  });

  it('redacta campos sensibles superficiales y anidados antes de escribir', () => {
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
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes('no-debe-aparecer'));
    assert.ok(!serialized.includes('tampoco'));
    assert.ok(!serialized.includes('super-secret'));
  });

  it('propaga campos base a través de child loggers', () => {
    const capture = createCapture();
    const logger = createLogger({
      destination: capture.stream,
      baseFields: { module: 'executor' },
    });

    const child = logger.child({ transactionId: 'tx-42' });
    child.info('bundle enviado');

    const entry = capture.entries[0];
    assert.equal(entry.module, 'executor');
    assert.equal(entry.transactionId, 'tx-42');
    assert.equal(entry.service, DEFAULT_SERVICE_NAME);
  });

  it('rechaza niveles inválidos con un error explícito', () => {
    const capture = createCapture();
    assert.throws(
      () =>
        createLogger({
          destination: capture.stream,
          // @ts-expect-error validación en runtime de nivel no permitido
          level: 'verbose',
        }),
      /LOG_LEVEL no válido/,
    );
  });
});

describe('resolveLoggerConfigFromEnv', () => {
  it('aplica defaults conservadores cuando no hay variables definidas', () => {
    const config = resolveLoggerConfigFromEnv(memoryProvider({}));
    assert.equal(config.level, 'info');
    assert.equal(config.service, DEFAULT_SERVICE_NAME);
    assert.equal(config.rotation.frequency, 'daily');
    assert.equal(config.rotation.size, '10m');
    assert.equal(config.rotation.limit, 7);
  });

  it('respeta los valores válidos del entorno inyectado', () => {
    const config = resolveLoggerConfigFromEnv(
      memoryProvider({
        LOG_LEVEL: 'debug',
        LOG_FILE_PATH: 'logs/custom.log',
        LOG_SERVICE_NAME: 'mev-runner',
        LOG_ROTATION_FREQUENCY: 'hourly',
        LOG_ROTATION_SIZE: '20m',
        LOG_ROTATION_LIMIT: '30',
      }),
    );
    assert.equal(config.level, 'debug');
    assert.equal(config.filePath, 'logs/custom.log');
    assert.equal(config.service, 'mev-runner');
    assert.equal(config.rotation.frequency, 'hourly');
    assert.equal(config.rotation.size, '20m');
    assert.equal(config.rotation.limit, 30);
  });

  it('ignora un LOG_ROTATION_LIMIT no numérico y cae al default', () => {
    const config = resolveLoggerConfigFromEnv(memoryProvider({ LOG_ROTATION_LIMIT: 'abc' }));
    assert.equal(config.rotation.limit, 7);
  });

  it('ignora un LOG_LEVEL inválido y cae al default info', () => {
    const config = resolveLoggerConfigFromEnv(memoryProvider({ LOG_LEVEL: 'verbose' }));
    assert.equal(config.level, 'info');
  });
});

describe('withTransactionContext', () => {
  it('propaga transactionId y campos extra en toda línea derivada', () => {
    const capture = createCapture();
    const logger = createLogger({ destination: capture.stream });

    const scoped = withTransactionContext(logger, 'tx-777', {
      route: 'SOL->USDC->SOL',
      pair: 'SOL/USDC',
    });
    scoped.info('primera línea');
    scoped.info({ step: 'sent-to-jito' }, 'segunda línea');

    assert.equal(capture.entries.length, 2);
    for (const entry of capture.entries) {
      assert.equal(entry.transactionId, 'tx-777');
      assert.equal(entry.route, 'SOL->USDC->SOL');
      assert.equal(entry.pair, 'SOL/USDC');
    }
    assert.equal(capture.entries[1].step, 'sent-to-jito');
  });

  it('lanza error si transactionId está vacío', () => {
    const capture = createCapture();
    const logger = createLogger({ destination: capture.stream });
    assert.throws(() => withTransactionContext(logger, ''), /transactionId es obligatorio/);
    assert.throws(() => withTransactionContext(logger, '   '), /transactionId es obligatorio/);
  });
});

describe('logTransactionEvent', () => {
  it('emite transaction:started en info con transactionId y expectedProfit', () => {
    const capture = createCapture();
    const logger = createLogger({ destination: capture.stream });

    logTransactionEvent(logger, {
      status: 'started',
      transactionId: 'tx-001',
      route: 'SOL->USDC->SOL',
      expectedProfit: '0.42',
    });

    assert.equal(capture.entries.length, 1);
    const entry = capture.entries[0];
    assert.equal(entry.level, 'info');
    assert.equal(entry.message, 'transaction:started');
    assert.equal(entry.transactionId, 'tx-001');
    assert.equal(entry.route, 'SOL->USDC->SOL');
    assert.equal(entry.expectedProfit, '0.42');
  });

  it('emite transaction:succeeded con profit y metadatos de bundle', () => {
    const capture = createCapture();
    const logger = createLogger({ destination: capture.stream });

    logTransactionEvent(logger, {
      status: 'succeeded',
      transactionId: 'tx-002',
      profit: 1.25,
      signatures: ['sig-a', 'sig-b'],
      slot: 300_123_456,
      bundleId: 'bundle-xyz',
      durationMs: 812,
    });

    const entry = capture.entries[0];
    assert.equal(entry.level, 'info');
    assert.equal(entry.message, 'transaction:succeeded');
    assert.equal(entry.transactionId, 'tx-002');
    assert.equal(entry.profit, 1.25);
    assert.deepEqual(entry.signatures, ['sig-a', 'sig-b']);
    assert.equal(entry.slot, 300_123_456);
    assert.equal(entry.bundleId, 'bundle-xyz');
    assert.equal(entry.durationMs, 812);
  });

  it('emite transaction:failed en warn con err serializado y campos de contexto', () => {
    const capture = createCapture();
    const logger = createLogger({ destination: capture.stream });

    const originalError = new Error('bundle rechazado por relay');
    logTransactionEvent(logger, {
      status: 'failed',
      transactionId: 'tx-003',
      route: 'SOL->USDT->SOL',
      error: originalError,
      reason: 'simulationFailure',
      attempts: 5,
      bundleId: 'bundle-abc',
      durationMs: 1234,
    });

    const entry = capture.entries[0];
    assert.equal(entry.level, 'warn');
    assert.equal(entry.message, 'transaction:failed');
    assert.equal(entry.transactionId, 'tx-003');
    assert.equal(entry.route, 'SOL->USDT->SOL');
    assert.equal(entry.reason, 'simulationFailure');
    assert.equal(entry.attempts, 5);
    assert.equal(entry.bundleId, 'bundle-abc');
    const err = entry.err as Record<string, unknown>;
    assert.ok(err, 'el evento failed debe incluir el campo err serializado');
    assert.equal(err.type, 'Error');
    assert.equal(err.message, 'bundle rechazado por relay');
    assert.equal(typeof err.stack, 'string');
  });

  it('serializa errores con causa y no filtra secretos anexados al Error', () => {
    const capture = createCapture();
    const logger = createLogger({ destination: capture.stream });

    const rootCause = new Error('rpc caído');
    const wrapped = new Error('fallo enviando bundle', { cause: rootCause }) as Error & {
      secretKey?: string;
    };
    wrapped.secretKey = 'valor-que-no-debe-aparecer';

    logTransactionEvent(logger, {
      status: 'failed',
      transactionId: 'tx-004',
      error: wrapped,
    });

    const entry = capture.entries[0];
    const err = entry.err as Record<string, unknown>;
    assert.equal(err.type, 'Error');
    assert.equal(err.message, 'fallo enviando bundle');
    assert.equal(err.secretKey, REDACTED_PLACEHOLDER);
    const cause = err.cause as Record<string, unknown>;
    assert.ok(cause);
    assert.equal(cause.message, 'rpc caído');
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes('valor-que-no-debe-aparecer'));
  });

  it('serializeError acepta strings, objetos y primitivos', () => {
    assert.deepEqual(serializeError('boom'), { type: 'String', message: 'boom' });
    assert.deepEqual(serializeError({ code: 42, details: 'x' }), {
      type: 'Object',
      code: 42,
      details: 'x',
    });
    assert.deepEqual(serializeError(null), { type: 'object', message: 'null' });
    assert.deepEqual(serializeError(undefined), { type: 'undefined', message: 'undefined' });
  });
});
