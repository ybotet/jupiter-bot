import test from 'node:test';
import assert from 'node:assert/strict';

import { Keypair } from '@solana/web3.js';

import type { SignedBundle } from './bundleBuilder';
import type { BundleSubmissionResult } from './jitoExecutor';
import { RetryHandler, type BundleSubmitter } from './retryHandler';

/** Construye un SignedBundle vacío pero válido para pruebas del RetryHandler. */
function createFakeBundle(): SignedBundle {
  return {
    transactions: [],
    payer: Keypair.generate().publicKey,
    lastValidBlockHeight: 100,
  };
}

/** Crea un submitter que devuelve resultados en secuencia y registra el orden de las llamadas. */
function createSubmitter(
  results: Array<BundleSubmissionResult | Error>,
): BundleSubmitter & { calls: number; bundles: SignedBundle[] } {
  const bundles: SignedBundle[] = [];
  let index = 0;
  return {
    calls: 0,
    bundles,
    submit: async (bundle) => {
      bundles.push(bundle);
      const next = results[index] ?? results[results.length - 1];
      index += 1;
      if (next instanceof Error) {
        throw next;
      }
      return next as BundleSubmissionResult;
    },
  };
}

/** Verifica que un envío exitoso al primer intento no genere reintentos ni backoff. */
test('RetryHandler devuelve confirmación inmediata al primer intento', async () => {
  const submitter = createSubmitter([
    {
      bundleId: 'uuid-1',
      signatures: ['sig1'],
      status: 'confirmed',
      slot: 100,
    },
  ]);
  const sleeps: number[] = [];
  const handler = new RetryHandler(submitter, {
    initialComputeUnitPrice: 1000,
    computeUnitPriceMultiplier: 1.1,
    initialBackoffMs: 10,
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
  });

  const prices: number[] = [];
  const outcome = await handler.execute(async (price) => {
    prices.push(price);
    return createFakeBundle();
  });

  assert.equal(outcome.finalStatus, 'confirmed');
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.bundleId, 'uuid-1');
  assert.deepEqual(prices, [1000]);
  assert.deepEqual(sleeps, []);
  assert.equal(outcome.history.length, 1);
});

/** Verifica que un timeout inicial provoque un reintento con computeUnitPrice mayor. */
test('RetryHandler reintenta con computeUnitPrice mayor tras un timeout', async () => {
  const submitter = createSubmitter([
    { bundleId: 'uuid-1', signatures: ['sig1'], status: 'timeout' },
    { bundleId: 'uuid-2', signatures: ['sig1'], status: 'confirmed', slot: 200 },
  ]);
  const sleeps: number[] = [];
  const handler = new RetryHandler(submitter, {
    initialComputeUnitPrice: 1000,
    computeUnitPriceMultiplier: 1.1,
    initialBackoffMs: 25,
    backoffMultiplier: 2,
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
  });

  const prices: number[] = [];
  const outcome = await handler.execute(async (price) => {
    prices.push(price);
    return createFakeBundle();
  });

  assert.equal(outcome.finalStatus, 'confirmed');
  assert.equal(outcome.attempts, 2);
  assert.deepEqual(prices, [1000, 1100]);
  assert.deepEqual(sleeps, [25]);
  assert.equal(outcome.history[0]?.status, 'timeout');
  assert.equal(outcome.history[1]?.status, 'confirmed');
});

/** Verifica que se agoten los reintentos y se devuelva el último estado no exitoso. */
test('RetryHandler agota los intentos con backoff exponencial cuando el bundle nunca se confirma', async () => {
  const submitter = createSubmitter([
    { bundleId: 'uuid-1', signatures: ['sig1'], status: 'timeout' },
    { bundleId: 'uuid-2', signatures: ['sig1'], status: 'rejected', rejectionReason: 'blockhashExpired' },
    { bundleId: 'uuid-3', signatures: ['sig1'], status: 'timeout' },
  ]);
  const sleeps: number[] = [];
  const handler = new RetryHandler(submitter, {
    maxAttempts: 3,
    initialComputeUnitPrice: 1000,
    computeUnitPriceMultiplier: 1.1,
    initialBackoffMs: 10,
    backoffMultiplier: 2,
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
  });

  const prices: number[] = [];
  const outcome = await handler.execute(async (price) => {
    prices.push(price);
    return createFakeBundle();
  });

  assert.equal(outcome.finalStatus, 'timeout');
  assert.equal(outcome.attempts, 3);
  assert.deepEqual(prices, [1000, 1100, 1210]);
  assert.deepEqual(sleeps, [10, 20]);
  assert.equal(outcome.history.length, 3);
  assert.equal(outcome.history[1]?.status, 'rejected');
});

/** Verifica que un error en el submitter no rompa el ciclo y permita seguir reintentando. */
test('RetryHandler tolera errores transitorios del submitter y continúa', async () => {
  const submitter = createSubmitter([
    new Error('Relay unreachable'),
    { bundleId: 'uuid-2', signatures: ['sig1'], status: 'accepted', slot: 300 },
  ]);
  const handler = new RetryHandler(submitter, {
    maxAttempts: 3,
    initialComputeUnitPrice: 1000,
    computeUnitPriceMultiplier: 1.5,
    initialBackoffMs: 0,
    sleepFn: async () => {
      // El backoff se anula para acelerar la prueba.
    },
  });

  const outcome = await handler.execute(async () => createFakeBundle());

  assert.equal(outcome.finalStatus, 'accepted');
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.history[0]?.status, 'error');
  assert.equal(outcome.history[0]?.error, 'Relay unreachable');
  assert.equal(outcome.history[1]?.status, 'accepted');
});

/** Verifica que si todos los intentos fallan con errores se propague una excepción final. */
test('RetryHandler lanza excepción cuando todos los intentos fallan con errores', async () => {
  const submitter = createSubmitter([
    new Error('boom-1'),
    new Error('boom-2'),
  ]);
  const handler = new RetryHandler(submitter, {
    maxAttempts: 2,
    initialComputeUnitPrice: 1000,
    computeUnitPriceMultiplier: 1.2,
    initialBackoffMs: 0,
    sleepFn: async () => undefined,
  });

  await assert.rejects(
    handler.execute(async () => createFakeBundle()),
    /Reintentos agotados.*boom-2/,
  );
});

/** Verifica la validación de las opciones de configuración del handler. */
test('RetryHandler rechaza configuraciones inválidas', () => {
  const submitter = createSubmitter([]);
  assert.throws(
    () => new RetryHandler(submitter, { maxAttempts: 0 }),
    /maxAttempts/,
  );
  assert.throws(
    () => new RetryHandler(submitter, { computeUnitPriceMultiplier: 1 }),
    /computeUnitPriceMultiplier/,
  );
  assert.throws(
    () => new RetryHandler(submitter, { initialComputeUnitPrice: 0 }),
    /initialComputeUnitPrice/,
  );
});

