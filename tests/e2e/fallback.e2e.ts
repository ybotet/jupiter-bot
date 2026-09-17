import test from 'node:test';
import assert from 'node:assert/strict';

import { Keypair, TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';

import { BundleBuilder, type SignedBundle } from '../../src/core/executor/bundleBuilder';
import { RetryHandler, type BundleSubmitter } from '../../src/core/executor/retryHandler';
import type {
  BundleSubmissionResult,
  BundleSubmissionStatus,
} from '../../src/core/executor/jitoExecutor';
import {
  RpcManager,
  type RpcConnection,
  type RpcEndpoint,
} from '../../src/core/network/rpcManager';
import { MEV_EXECUTOR_PROGRAM_ID } from '../../src/contracts/anchor/mevExecutor';

const RPC_ENDPOINTS: RpcEndpoint[] = [
  { name: 'Helius', url: 'https://helius.simulated' },
  { name: 'Triton', url: 'https://triton.simulated' },
  { name: 'QuickNode', url: 'https://quicknode.simulated' },
];

/** Crea una conexión RPC simulada que falla o devuelve blockhash controlado. */
function createRpcConnection(endpoint: RpcEndpoint, calls: string[]): RpcConnection {
  return {
    getLatestBlockhash: async () => {
      calls.push(endpoint.name);
      if (endpoint.name === 'Helius') {
        throw new Error('RPC primario no disponible');
      }
      return {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 500,
      };
    },
  };
}

/** Crea un manager con Helius caído y Triton disponible para el escenario E2E. */
function createFailoverManager(calls: string[]): RpcManager {
  return new RpcManager({
    endpoints: RPC_ENDPOINTS,
    connectionFactory: (endpoint) => createRpcConnection(endpoint, calls),
  });
}

/** Crea un submitter que simula timeout inicial y confirmación posterior. */
function createRetrySubmitter(statuses: BundleSubmissionStatus[]): BundleSubmitter & {
  prices: number[];
  submissions: SignedBundle[];
} {
  const prices: number[] = [];
  const submissions: SignedBundle[] = [];
  let attempt = 0;

  return {
    prices,
    submissions,
    async submit(bundle: SignedBundle): Promise<BundleSubmissionResult> {
      submissions.push(bundle);
      const status = statuses[attempt] ?? statuses[statuses.length - 1]!;
      attempt += 1;
      return {
        status,
        bundleId: `simulated-bundle-${attempt}`,
        signatures: bundle.transactions.map((transaction: VersionedTransaction) =>
          Buffer.from(transaction.signatures[0] ?? []).toString('base64'),
        ),
      };
    },
  };
}

/** Construye una transacción firmada usando el blockhash obtenido tras el fallback RPC. */
async function buildBundle(payer: Keypair, rpcManager: RpcManager): Promise<SignedBundle> {
  const blockhash = await rpcManager.request((connection) =>
    connection.getLatestBlockhash('processed'),
  );
  const builder = new BundleBuilder({
    connection: {
      getLatestBlockhash: async () => blockhash,
    },
    payer,
    programId: MEV_EXECUTOR_PROGRAM_ID,
  });
  return builder.build([
    [
      new TransactionInstruction({
        programId: MEV_EXECUTOR_PROGRAM_ID,
        keys: [],
        data: Buffer.from([0]),
      }),
    ],
  ]);
}

/**
 * Verifica que el sistema rote desde un RPC caído y que el retry confirme el
 * mismo bundle lógico en el segundo intento sin perder la oportunidad.
 */
test('E2E: fallback RPC y reintento confirman el bundle sin perder la oportunidad', async () => {
  const payer = Keypair.generate();
  const rpcCalls: string[] = [];
  const rpcManager = createFailoverManager(rpcCalls);
  const submitter = createRetrySubmitter(['timeout', 'confirmed']);
  const retryHandler = new RetryHandler(submitter, {
    maxAttempts: 2,
    initialComputeUnitPrice: 1_000,
    computeUnitPriceMultiplier: 1.5,
    initialBackoffMs: 0,
    sleepFn: async () => undefined,
    logger: undefined,
  });

  const outcome = await retryHandler.execute(async (computeUnitPrice) => {
    submitter.prices.push(computeUnitPrice);
    return buildBundle(payer, rpcManager);
  });

  assert.deepEqual(rpcCalls, ['Helius', 'Triton', 'Triton']);
  assert.equal(rpcManager.getActiveProvider(), 'Triton');
  assert.equal(outcome.finalStatus, 'confirmed');
  assert.equal(outcome.attempts, 2);
  assert.deepEqual(
    outcome.history.map((attempt) => attempt.status),
    ['timeout', 'confirmed'],
  );
  assert.deepEqual(submitter.prices, [1_000, 1_500]);
  assert.equal(submitter.submissions.length, 2);
  assert.equal(submitter.submissions[0]!.transactions.length, 1);
  assert.equal(submitter.submissions[1]!.transactions.length, 1);
});
