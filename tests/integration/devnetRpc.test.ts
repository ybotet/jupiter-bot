/**
 * Pruebas de integración contra el RPC de Solana devnet real.
 *
 * Estas pruebas son opt-in: se activan con `RUN_DEVNET_TESTS=1`. Nunca envían
 * transacciones ni consumen SOL, solo leen del cluster (`getLatestBlockhash`,
 * `getBlockHeight`, `getSignatureStatuses`) para validar que:
 *
 * 1. El `BundleBuilder` compila y firma transacciones con un blockhash real.
 * 2. El `JitoExecutor` sondea correctamente contra un RPC HTTP real.
 * 3. El pipeline completo se comporta como en producción cuando el relay Jito
 *    (simulado) no confirma el bundle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SystemProgram } from '@solana/web3.js';

import { BundleBuilder } from '../../src/core/executor/bundleBuilder';
import { JitoExecutor } from '../../src/core/executor/jitoExecutor';
import { MEV_EXECUTOR_PROGRAM_ID } from '../../src/contracts/anchor/mevExecutor';

import { createDevnetHarness, skipIfDevnetDisabled } from './devnetHarness';
import { JitoSimulator } from './jitoSimulator';

test('devnet: BundleBuilder obtiene un blockhash real y firma la transacción', async (t) => {
  if (skipIfDevnetDisabled(t)) {
    return;
  }
  const { connection, payer } = createDevnetHarness();
  const builder = new BundleBuilder({
    connection,
    payer,
    programId: MEV_EXECUTOR_PROGRAM_ID,
  });

  const bundle = await builder.build([
    [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: 0,
      }),
    ],
  ]);

  assert.equal(bundle.transactions.length, 1);
  assert.ok(bundle.lastValidBlockHeight > 0, 'lastValidBlockHeight debe ser positivo');
  assert.equal(bundle.transactions[0]!.signatures.length, 1);
  assert.ok(
    bundle.transactions[0]!.signatures[0]!.some((byte) => byte !== 0),
    'la firma no puede estar vacía',
  );
});

test('devnet: JitoExecutor devuelve timeout con RPC real y relay simulado silencioso', async (t) => {
  if (skipIfDevnetDisabled(t)) {
    return;
  }
  const { connection, payer } = createDevnetHarness();
  const builder = new BundleBuilder({
    connection,
    payer,
    programId: MEV_EXECUTOR_PROGRAM_ID,
  });
  const simulator = new JitoSimulator({ mode: 'silent' });
  const executor = new JitoExecutor({
    relayClient: simulator,
    connection,
    pollIntervalMs: 500,
    confirmationBlockWindow: 1,
  });

  const bundle = await builder.build([
    [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: 0,
      }),
    ],
  ]);

  const result = await executor.submit(bundle);

  // La transacción nunca se envía on-chain: la firma no existirá en el RPC y
  // el relay simulado no emite eventos, por lo que se espera `timeout`.
  assert.equal(result.status, 'timeout');
  assert.equal(result.signatures.length, 1);
  assert.equal(simulator.getInteractions().length, 1);
});
