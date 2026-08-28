import test from 'node:test';
import assert from 'node:assert/strict';

import { Keypair, VersionedTransaction } from '@solana/web3.js';

import type { SignedBundle } from './bundleBuilder';
import {
  JitoExecutor,
  JITO_MAX_TX_PER_BUNDLE,
  type BundleResultEvent,
  type JitoRelayClient,
  type SignatureStatusProvider,
  type SignatureStatusValue,
} from './jitoExecutor';

/** Crea una VersionedTransaction firmada con una firma sintética estable. */
function createSignedTransaction(seed = 1): VersionedTransaction {
  const dummyMessage = {
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 0,
    },
    staticAccountKeys: [Keypair.generate().publicKey],
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    compiledInstructions: [],
    addressTableLookups: [],
  } as unknown as VersionedTransaction['message'];

  const signature = new Uint8Array(64);
  signature[0] = seed;
  return {
    message: dummyMessage,
    signatures: [signature],
  } as unknown as VersionedTransaction;
}

/** Construye un SignedBundle de prueba con firmas y ventana de validez. */
function createSignedBundle(txCount = 1, lastValidBlockHeight = 100): SignedBundle {
  const transactions = Array.from({ length: txCount }, (_, index) =>
    createSignedTransaction(index + 1),
  );
  return {
    transactions,
    payer: Keypair.generate().publicKey,
    lastValidBlockHeight,
  };
}

/** Cliente falso del relay Jito que registra los envíos y controla el resultado emitido. */
function createRelayClient(
  options: { sendBundleId?: string; bundleResult?: BundleResultEvent; failOnSend?: boolean } = {},
): JitoRelayClient & { sentBundles: VersionedTransaction[][] } {
  const sentBundles: VersionedTransaction[][] = [];
  return {
    sentBundles,
    sendBundle: async (transactions) => {
      if (options.failOnSend) {
        throw new Error('Relay unreachable');
      }
      sentBundles.push(transactions);
      return options.sendBundleId ?? 'test-bundle-uuid';
    },
    onBundleResult: (successCallback) => {
      if (options.bundleResult) {
        // El evento se emite de forma síncrona para reflejar el flujo real de gRPC.
        successCallback(options.bundleResult);
      }
      return () => undefined;
    },
  };
}

/** Proveedor RPC falso configurable con estados por firma y bloques progresivos. */
function createConnection(
  options: {
    statuses?: Array<SignatureStatusValue | null>;
    blockHeights?: number[];
    followUpStatuses?: Array<SignatureStatusValue | null>;
  } = {},
): SignatureStatusProvider & { calls: number } {
  const { statuses, blockHeights, followUpStatuses } = options;
  let blockCalls = 0;
  let statusCalls = 0;
  const connection = {
    calls: 0,
    getSignatureStatuses: async (signatures: string[]) => {
      statusCalls += 1;
      const source =
        statusCalls > 1 && followUpStatuses !== undefined ? followUpStatuses : (statuses ?? []);
      const value = signatures.map((_, index) => source[index] ?? null);
      return { value };
    },
    getBlockHeight: async () => {
      const heights = blockHeights ?? [10, 10, 20];
      const value = heights[Math.min(blockCalls, heights.length - 1)];
      blockCalls += 1;
      return value;
    },
  };
  return connection;
}

/** Verifica que el ejecutor devuelve estado 'confirmed' cuando las firmas están on-chain. */
test('JitoExecutor confirma un bundle cuando las firmas están confirmadas on-chain', async () => {
  const relayClient = createRelayClient();
  const connection = createConnection({
    statuses: [{ slot: 999, confirmationStatus: 'confirmed', err: null }],
    blockHeights: [10],
  });
  const executor = new JitoExecutor({
    relayClient,
    connection,
    pollIntervalMs: 5,
    confirmationBlockWindow: 3,
  });

  const result = await executor.submit(createSignedBundle());

  assert.equal(result.status, 'confirmed');
  assert.equal(result.slot, 999);
  assert.equal(result.bundleId, 'test-bundle-uuid');
  assert.equal(result.signatures.length, 1);
  assert.equal(relayClient.sentBundles.length, 1);
});

/** Verifica que un rechazo del relay se propaga como estado 'rejected'. */
test('JitoExecutor marca el bundle como rechazado si el relay lo descarta', async () => {
  const relayClient = createRelayClient({
    bundleResult: {
      bundleId: 'test-bundle-uuid',
      status: 'rejected',
      rejectionReason: 'simulationFailure: slippage exceeded',
    },
  });
  const connection = createConnection({
    statuses: [null],
    followUpStatuses: [null],
    blockHeights: [10, 10, 10, 10],
  });
  const executor = new JitoExecutor({
    relayClient,
    connection,
    pollIntervalMs: 5,
    confirmationBlockWindow: 2,
  });

  const result = await executor.submit(createSignedBundle());

  assert.equal(result.status, 'rejected');
  assert.match(result.rejectionReason ?? '', /simulationFailure/);
});

/** Verifica que se produce 'timeout' cuando el bundle no se confirma dentro de la ventana. */
test('JitoExecutor devuelve timeout si la ventana de bloques expira sin confirmación', async () => {
  const relayClient = createRelayClient();
  const connection = createConnection({
    statuses: [null],
    followUpStatuses: [null],
    blockHeights: [10, 14, 14, 14],
  });
  const executor = new JitoExecutor({
    relayClient,
    connection,
    pollIntervalMs: 5,
    confirmationBlockWindow: 3,
  });

  const result = await executor.submit(createSignedBundle(1, 12));

  assert.equal(result.status, 'timeout');
});

/** Verifica que se rechaza un bundle vacío antes de contactar al relay. */
test('JitoExecutor rechaza bundles vacíos antes de contactar al relay', async () => {
  const relayClient = createRelayClient();
  const connection = createConnection();
  const executor = new JitoExecutor({ relayClient, connection });

  await assert.rejects(
    executor.submit({
      transactions: [],
      payer: Keypair.generate().publicKey,
      lastValidBlockHeight: 100,
    }),
    /no contiene transacciones firmadas/,
  );
  assert.equal(relayClient.sentBundles.length, 0);
});

/** Verifica que un bundle con demasiadas transacciones se rechaza on-shot. */
test('JitoExecutor rechaza bundles con más transacciones que el máximo permitido', async () => {
  const relayClient = createRelayClient();
  const connection = createConnection();
  const executor = new JitoExecutor({ relayClient, connection });

  const oversized = createSignedBundle(JITO_MAX_TX_PER_BUNDLE + 1, 100);

  await assert.rejects(executor.submit(oversized), /admite hasta/);
});

/** Verifica que un fallo on-chain se propaga como excepción para permitir reintentos. */
test('JitoExecutor lanza un error si la firma reporta un fallo on-chain', async () => {
  const relayClient = createRelayClient();
  const connection = createConnection({
    statuses: [{ slot: 12, confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } }],
    blockHeights: [10],
  });
  const executor = new JitoExecutor({
    relayClient,
    connection,
    pollIntervalMs: 5,
    confirmationBlockWindow: 3,
  });

  await assert.rejects(executor.submit(createSignedBundle()), /falló on-chain/);
});

