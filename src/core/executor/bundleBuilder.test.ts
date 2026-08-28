import test from 'node:test';
import assert from 'node:assert/strict';

import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';

import {
  MEV_EXECUTOR_PROGRAM_ID,
  type ArbitrageBundleRequest,
  type SwapInstructionData,
} from '../../contracts/anchor/mevExecutor';
import {
  BundleBuilder,
  EXECUTE_ARBITRAGE_DISCRIMINATOR,
  type BlockhashProvider,
} from './bundleBuilder';

const programId = MEV_EXECUTOR_PROGRAM_ID;

/** Crea un proveedor RPC falso con un blockhash estable para las pruebas. */
function createConnection(): BlockhashProvider {
  const blockhash = Keypair.generate().publicKey.toBase58();

  return {
    getLatestBlockhash: async () => ({
      blockhash,
      lastValidBlockHeight: 42,
    }),
  };
}

/** Crea una instrucción Anchor simulada para el programa autorizado. */
function createInstruction(instructionProgramId = programId): TransactionInstruction {
  return new TransactionInstruction({
    programId: instructionProgramId,
    keys: [],
    data: Buffer.from([1, 2, 3]),
  });
}

/** Crea una instrucción CPI de swap simulada para pruebas de arbitraje. */
function createSwapInstruction(seed: number): SwapInstructionData {
  const programIdForSwap = Keypair.generate().publicKey;

  return {
    programId: programIdForSwap,
    accounts: [
      {
        pubkey: Keypair.generate().publicKey,
        isSigner: false,
        isWritable: true,
      },
    ],
    data: Uint8Array.from([seed, seed + 1, seed + 2]),
  };
}

/** Crea una petición mínima de arbitraje para probar la secuenciación compra/venta. */
function createArbitrageRequest(): ArbitrageBundleRequest {
  return {
    accounts: {
      state: Keypair.generate().publicKey,
      inputTokenAccount: Keypair.generate().publicKey,
      outputTokenAccount: Keypair.generate().publicKey,
    },
    params: {
      inputMint: Keypair.generate().publicKey,
      outputMint: Keypair.generate().publicKey,
      inputAmount: 1_000n,
      expectedOutputAmount: 1_050n,
      minimumOutputAmount: 1_020n,
      gasEstimated: 10n,
      jupiterFeesEstimated: 5n,
      jitoTipEstimated: 3n,
      maximumSlippageBps: 50,
    },
    buyInstruction: createSwapInstruction(1),
    sellInstruction: createSwapInstruction(2),
  };
}

/** Comprueba que el builder firma transacciones y conserva su caducidad RPC. */
test('BundleBuilder builds signed transactions for the Anchor program', async () => {
  const payer = Keypair.generate();
  const builder = new BundleBuilder({ connection: createConnection(), payer, programId });

  const bundle = await builder.build([[createInstruction()], [createInstruction()]]);

  assert.equal(bundle.transactions.length, 2);
  assert.equal(bundle.payer.toBase58(), payer.publicKey.toBase58());
  assert.equal(bundle.lastValidBlockHeight, 42);
  assert.equal(bundle.transactions[0].signatures.length, 1);
});

/** Comprueba que se construye execute_arbitrage con compra y venta secuenciadas. */
test('BundleBuilder builds execute_arbitrage with buy and sell instructions', async () => {
  const payer = Keypair.generate();
  const builder = new BundleBuilder({ connection: createConnection(), payer, programId });
  const request = createArbitrageRequest();

  const instruction = builder.buildExecuteArbitrageInstruction(request);
  const bundle = await builder.buildArbitrageBundle(request);

  assert.ok(instruction.programId.equals(programId));
  assert.equal(instruction.data.subarray(0, 8).compare(EXECUTE_ARBITRAGE_DISCRIMINATOR), 0);
  assert.equal(instruction.keys[1]?.pubkey.toBase58(), payer.publicKey.toBase58());
  assert.ok(instruction.keys.some((key) => key.pubkey.equals(request.buyInstruction.programId)));
  assert.ok(instruction.keys.some((key) => key.pubkey.equals(request.sellInstruction.programId)));
  assert.equal(bundle.transactions.length, 1);
  assert.equal(bundle.transactions[0].signatures.length, 1);
});

/** Comprueba que se rechazan instrucciones pertenecientes a otro programa. */
test('BundleBuilder rejects instructions outside the configured Anchor program', async () => {
  const builder = new BundleBuilder({
    connection: createConnection(),
    payer: Keypair.generate(),
    programId,
  });

  await assert.rejects(
    builder.build([
      [createInstruction(new PublicKey('SysvarRent111111111111111111111111111111111'))],
    ]),
    /programa no autorizado/,
  );
});

/** Comprueba que un bundle vacío se rechaza antes de consultar el RPC. */
test('BundleBuilder rejects empty bundles', async () => {
  const builder = new BundleBuilder({
    connection: createConnection(),
    payer: Keypair.generate(),
    programId,
  });

  await assert.rejects(builder.build([]), /al menos una transacción/);
});

/** Comprueba que swaps inválidos se rechazan antes de firmar el bundle. */
test('BundleBuilder rejects invalid swap instructions in arbitrage requests', () => {
  const builder = new BundleBuilder({
    connection: createConnection(),
    payer: Keypair.generate(),
    programId,
  });
  const request = createArbitrageRequest();
  request.sellInstruction.data = new Uint8Array();

  assert.throws(
    () => builder.buildExecuteArbitrageInstruction(request),
    /instrucción de venta no contiene datos/,
  );
});
