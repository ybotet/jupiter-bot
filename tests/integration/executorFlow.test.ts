/**
 * Pruebas de integración del flujo `BundleBuilder` → `JitoExecutor` → `RetryHandler`
 * usando el simulador de Jito en memoria y un `BlockhashProvider` inyectable.
 *
 * Estas pruebas se ejecutan siempre (no requieren red) porque validan el
 * cableado de los componentes reales entre sí. Las variantes contra devnet
 * viven en `devnetRpc.test.ts` y son opt-in vía `RUN_DEVNET_TESTS=1`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Keypair,
  PublicKey,
  SystemProgram,
  type Commitment,
} from '@solana/web3.js';

import { BundleBuilder } from '../../src/core/executor/bundleBuilder';
import {
  JitoExecutor,
  type SignatureStatusProvider,
  type SignatureStatusValue,
} from '../../src/core/executor/jitoExecutor';
import { RetryHandler } from '../../src/core/executor/retryHandler';
import { MEV_EXECUTOR_PROGRAM_ID } from '../../src/contracts/anchor/mevExecutor';

import { JitoSimulator } from './jitoSimulator';

/**
 * `BlockhashProvider` en memoria: emula el RPC devolviendo un blockhash
 * determinista y una ventana de validez creciente entre invocaciones.
 */
function createFakeBlockhashProvider(): {
  getLatestBlockhash: (commitment?: Commitment) => Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  calls: number;
} {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    getLatestBlockhash: async () => {
      state.calls += 1;
      return {
        // Blockhash de 32 bytes en base58 (PublicKey random cumple el formato).
        blockhash: Keypair.generate().publicKey.toBase58(),
        // Se aleja la ventana en cada llamada para evitar caducidades espurias.
        lastValidBlockHeight: 100 + state.calls,
      };
    },
  };
}

/**
 * `SignatureStatusProvider` en memoria que devuelve el estado programado y
 * un `blockHeight` progresivo entre invocaciones para controlar la ventana.
 */
function createFakeStatusProvider(
  statuses: Array<SignatureStatusValue | null>,
  blockHeights: number[] = [10, 10, 20],
): SignatureStatusProvider {
  let statusCall = 0;
  let heightCall = 0;
  return {
    getSignatureStatuses: async (signatures) => {
      const snapshot = statuses[statusCall] ?? null;
      statusCall += 1;
      return {
        value: signatures.map(() => snapshot),
      };
    },
    getBlockHeight: async () => {
      const value = blockHeights[Math.min(heightCall, blockHeights.length - 1)];
      heightCall += 1;
      return value;
    },
  };
}

/** Construye una instrucción trivial contra el `MEV_EXECUTOR_PROGRAM_ID`. */
function buildDummyTransferInstruction(payer: PublicKey) {
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: payer,
    lamports: 0,
  });
}

/**
 * Flujo feliz completo: el builder construye una transacción firmada, el
 * ejecutor la envía al relay simulado y confirma vía evento `accepted`.
 */
test('flujo BundleBuilder → JitoExecutor confirma el bundle cuando el relay lo acepta', async () => {
  const payer = Keypair.generate();
  const blockhashProvider = createFakeBlockhashProvider();
  const statusProvider = createFakeStatusProvider(
    [{ slot: 42, confirmationStatus: 'confirmed', err: null }],
    [10, 10, 20],
  );
  const simulator = new JitoSimulator({ mode: 'accepted', slot: 42 });

  const builder = new BundleBuilder({
    connection: blockhashProvider,
    payer,
    programId: MEV_EXECUTOR_PROGRAM_ID,
  });
  const executor = new JitoExecutor({
    relayClient: simulator,
    connection: statusProvider,
    pollIntervalMs: 5,
    confirmationBlockWindow: 3,
  });

  const bundle = await builder.build([[buildDummyTransferInstruction(payer.publicKey)]]);
  const result = await executor.submit(bundle);

  assert.equal(result.status, 'confirmed');
  assert.equal(result.slot, 42);
  assert.equal(result.signatures.length, 1);
  assert.equal(simulator.getInteractions().length, 1);
  assert.equal(simulator.getInteractions()[0]?.transactionCount, 1);
});

/**
 * Un rechazo del relay debe propagarse como `status: 'rejected'` con el
 * motivo original devuelto por el simulador.
 */
test('flujo BundleBuilder → JitoExecutor propaga el motivo de rechazo del relay', async () => {
  const payer = Keypair.generate();
  const blockhashProvider = createFakeBlockhashProvider();
  const statusProvider = createFakeStatusProvider([null, null], [10, 10, 10, 10]);
  const simulator = new JitoSimulator({
    mode: 'rejected',
    rejectionReason: 'stateAuctionBidRejected',
  });

  const builder = new BundleBuilder({
    connection: blockhashProvider,
    payer,
    programId: MEV_EXECUTOR_PROGRAM_ID,
  });
  const executor = new JitoExecutor({
    relayClient: simulator,
    connection: statusProvider,
    pollIntervalMs: 5,
    confirmationBlockWindow: 2,
  });

  const bundle = await builder.build([[buildDummyTransferInstruction(payer.publicKey)]]);
  const result = await executor.submit(bundle);

  assert.equal(result.status, 'rejected');
  assert.equal(result.rejectionReason, 'stateAuctionBidRejected');
});

/**
 * El modo `silent` reproduce la ausencia de evento del block-engine: cuando
 * la ventana de bloques se agota sin confirmación, se devuelve `timeout`.
 */
test('flujo BundleBuilder → JitoExecutor devuelve timeout cuando el relay guarda silencio', async () => {
  const payer = Keypair.generate();
  const blockhashProvider = createFakeBlockhashProvider();
  const statusProvider = createFakeStatusProvider([null, null], [10, 14, 14, 14]);
  const simulator = new JitoSimulator({ mode: 'silent' });

  const builder = new BundleBuilder({
    connection: blockhashProvider,
    payer,
    programId: MEV_EXECUTOR_PROGRAM_ID,
  });
  const executor = new JitoExecutor({
    relayClient: simulator,
    connection: statusProvider,
    pollIntervalMs: 5,
    confirmationBlockWindow: 3,
  });

  const bundle = await builder.build([[buildDummyTransferInstruction(payer.publicKey)]]);
  const result = await executor.submit(bundle);

  assert.equal(result.status, 'timeout');
});

/**
 * Prueba end-to-end del `RetryHandler`: el primer intento acaba en `timeout`
 * (silencio del relay), el segundo se confirma. Se verifica el escalado del
 * `computeUnitPrice`, el número de intentos y el historial completo.
 */
test('flujo RetryHandler reintenta con computeUnitPrice creciente hasta confirmar', async () => {
  const payer = Keypair.generate();
  const blockhashProvider = createFakeBlockhashProvider();
  // La cadena de estados/bloques cubre dos intentos consecutivos: el primero
  // agota la ventana (blockHeights crecientes) sin status, el segundo confirma.
  const statusProvider = createFakeStatusProvider(
    [null, null, { slot: 77, confirmationStatus: 'confirmed', err: null }],
    [10, 14, 14, 20, 20, 20],
  );
  const simulator = new JitoSimulator();
  simulator.queueMode('silent');
  simulator.queueMode('accepted');

  const builder = new BundleBuilder({
    connection: blockhashProvider,
    payer,
    programId: MEV_EXECUTOR_PROGRAM_ID,
  });
  const executor = new JitoExecutor({
    relayClient: simulator,
    connection: statusProvider,
    pollIntervalMs: 5,
    confirmationBlockWindow: 3,
  });

  const observedPrices: number[] = [];
  const retryHandler = new RetryHandler(executor, {
    maxAttempts: 3,
    initialComputeUnitPrice: 1_000,
    computeUnitPriceMultiplier: 1.5,
    initialBackoffMs: 0,
    // El sleep real se sustituye para mantener el test determinista.
    sleepFn: async () => undefined,
  });

  const outcome = await retryHandler.execute(async (computeUnitPrice) => {
    observedPrices.push(computeUnitPrice);
    return builder.build([[buildDummyTransferInstruction(payer.publicKey)]]);
  });

  assert.equal(outcome.finalStatus, 'confirmed');
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.history.length, 2);
  assert.equal(outcome.history[0]?.status, 'timeout');
  assert.equal(outcome.history[1]?.status, 'confirmed');
  assert.equal(observedPrices.length, 2);
  assert.ok(
    observedPrices[1]! > observedPrices[0]!,
    'el segundo intento debe usar un computeUnitPrice mayor',
  );
  assert.equal(simulator.getInteractions().length, 2);
});

/**
 * El `RetryHandler` debe agotar reintentos cuando el relay siempre rechaza y
 * devolver el último motivo de rechazo intacto para su registro posterior.
 */
test('flujo RetryHandler agota reintentos si el relay rechaza sistemáticamente', async () => {
  const payer = Keypair.generate();
  const blockhashProvider = createFakeBlockhashProvider();
  const statusProvider = createFakeStatusProvider([null, null, null], [10, 10, 10, 10, 10, 10]);
  const simulator = new JitoSimulator({
    mode: 'rejected',
    rejectionReason: 'insufficientTip',
  });

  const builder = new BundleBuilder({
    connection: blockhashProvider,
    payer,
    programId: MEV_EXECUTOR_PROGRAM_ID,
  });
  const executor = new JitoExecutor({
    relayClient: simulator,
    connection: statusProvider,
    pollIntervalMs: 5,
    confirmationBlockWindow: 2,
  });

  const retryHandler = new RetryHandler(executor, {
    maxAttempts: 2,
    initialComputeUnitPrice: 1_000,
    computeUnitPriceMultiplier: 1.2,
    initialBackoffMs: 0,
    sleepFn: async () => undefined,
  });

  const outcome = await retryHandler.execute(() =>
    builder.build([[buildDummyTransferInstruction(payer.publicKey)]]),
  );

  assert.equal(outcome.finalStatus, 'rejected');
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.rejectionReason, 'insufficientTip');
  assert.equal(outcome.history.length, 2);
  assert.equal(simulator.getInteractions().length, 2);
});


