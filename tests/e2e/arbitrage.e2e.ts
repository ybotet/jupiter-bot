import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as anchor from '@coral-xyz/anchor';
import {
  createMint,
  createMintToInstruction,
  createTransferInstruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type { Idl } from '@coral-xyz/anchor';

import { MEV_EXECUTOR_PROGRAM_ID } from '../../src/contracts/anchor/mevExecutor';

const DEVNET_TESTS_ENV = 'RUN_DEVNET_TESTS';

/** Carga el IDL generado para interactuar con el programa ya desplegado. */
function loadExecutorIdl(): Idl {
  const idlPath = resolve(process.cwd(), 'target/idl/mev_executor.json');
  return JSON.parse(readFileSync(idlPath, 'utf8')) as Idl;
}

/** Convierte una instrucción web3 en los datos serializables que espera Anchor. */
function toSwapData(instruction: anchor.web3.TransactionInstruction) {
  return {
    programId: instruction.programId,
    accounts: instruction.keys.map((account) => ({
      pubkey: account.pubkey,
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: instruction.data,
  };
}

/** Construye un cliente Anchor contra el programa desplegado en Devnet. */
function createDevnetProgram(): {
  provider: anchor.AnchorProvider;
  program: anchor.Program;
} {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new anchor.Program(loadExecutorIdl(), provider);
  assert.equal(program.programId.toBase58(), MEV_EXECUTOR_PROGRAM_ID.toBase58());
  return { provider, program };
}

/**
 * Simula una oportunidad rentable con dos CPI SPL reales en Devnet:
 * acuña 100 unidades durante la compra y las devuelve durante la venta.
 * La prueba confirma la transacción y verifica beneficio positivo.
 */
test('devnet E2E: ejecuta un arbitraje rentable y confirma la transacción', async (t) => {
  if (process.env[DEVNET_TESTS_ENV] !== '1') {
    t.skip(`Exporta ${DEVNET_TESTS_ENV}=1 para habilitar esta prueba`);
    return;
  }

  const { provider, program } = createDevnetProgram();
  const payer = provider.wallet.payer;
  if (!payer) {
    throw new Error('ANCHOR_WALLET debe resolver una Keypair para la prueba Devnet');
  }

  const state = anchor.web3.Keypair.generate();
  const outputOwner = anchor.web3.Keypair.generate();
  const mint = await createMint(provider.connection, payer, payer.publicKey, null, 0);
  const inputTokenAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    payer,
    mint,
    payer.publicKey,
  );
  const outputTokenAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    payer,
    mint,
    outputOwner.publicKey,
  );

  await provider.sendAndConfirm(
    new anchor.web3.Transaction().add(
      createMintToInstruction(mint, inputTokenAccount.address, payer.publicKey, 1_000),
    ),
  );

  const initialAccount = await getAccount(provider.connection, inputTokenAccount.address);
  const initialBalance = initialAccount.amount;

  const initializeSignature = await program.methods
    .initialize()
    .accounts({
      state: state.publicKey,
      authority: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([state])
    .rpc();
  await provider.connection.confirmTransaction(initializeSignature, 'confirmed');

  const buyInstruction = createMintToInstruction(
    mint,
    outputTokenAccount.address,
    payer.publicKey,
    100,
  );
  const sellInstruction = createTransferInstruction(
    outputTokenAccount.address,
    inputTokenAccount.address,
    outputOwner.publicKey,
    100,
  );

  const signature = await program.methods
    .executeArbitrage(
      {
        inputMint: mint,
        outputMint: mint,
        inputAmount: new anchor.BN(1),
        expectedOutputAmount: new anchor.BN(100),
        minimumOutputAmount: new anchor.BN(100),
        gasEstimated: new anchor.BN(0),
        jupiterFeesEstimated: new anchor.BN(0),
        jitoTipEstimated: new anchor.BN(0),
        maximumSlippageBps: 50,
      },
      toSwapData(buyInstruction),
      toSwapData(sellInstruction),
    )
    .accounts({
      state: state.publicKey,
      authority: provider.wallet.publicKey,
      inputTokenAccount: inputTokenAccount.address,
      outputTokenAccount: outputTokenAccount.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts([
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: outputTokenAccount.address, isSigner: false, isWritable: true },
      { pubkey: inputTokenAccount.address, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: outputOwner.publicKey, isSigner: true, isWritable: false },
    ])
    .signers([payer, outputOwner])
    .rpc();

  const confirmation = await provider.connection.confirmTransaction(signature, 'confirmed');
  assert.equal(confirmation.value.err, null);

  const finalAccount = await getAccount(provider.connection, inputTokenAccount.address);
  assert.ok(finalAccount.amount > initialBalance, 'el saldo final debe superar el inicial');
  assert.equal(finalAccount.amount, 1_100n);
});
