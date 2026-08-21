import * as anchor from '@coral-xyz/anchor';
import assert from 'node:assert/strict';
import {
  createMint,
  createMintToInstruction,
  createTransferInstruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

declare function describe(name: string, callback: () => void): void;
declare function it(name: string, callback: () => Promise<void>): void;

/** Ejecuta las pruebas de integración del ejecutor contra el proveedor de Anchor. */
describe('mev_executor', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.mevExecutor;

  /** Verifica que el estado del ejecutor se crea con la autoridad del proveedor. */
  it('inicializa el estado del ejecutor', async () => {
    const state = anchor.web3.Keypair.generate();

    await program.methods
      .initialize()
      .accounts({
        state: state.publicKey,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([state])
      .rpc();

    const storedState = await program.account.executorState.fetch(state.publicKey);
    assert.equal(storedState.authority.toBase58(), provider.wallet.publicKey.toBase58());
    assert.equal(storedState.active, true);
  });

  /** Verifica dos CPI SPL secuenciales y la validación de beneficio del ejecutor. */
  it('simula una compra y una venta rentables', async () => {
    const state = anchor.web3.Keypair.generate();
    const payer = provider.wallet.payer;
    if (!payer) {
      throw new Error('El proveedor de Anchor debe exponer una Keypair para la prueba');
    }

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

    await program.methods
      .initialize()
      .accounts({
        state: state.publicKey,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([state])
      .rpc();

    const buyInstruction = createMintToInstruction(
      mint,
      outputTokenAccount.address,
      payer.publicKey,
      100,
    );
    const sellInstruction = createTransferInstruction(
      outputTokenAccount.address,
      inputTokenAccount.address,
      payer.publicKey,
      100,
    );
    const toSwapData = (instruction: anchor.web3.TransactionInstruction) => ({
      programId: instruction.programId,
      accounts: instruction.keys.map((account) => ({
        pubkey: account.pubkey,
        isSigner: account.isSigner,
        isWritable: account.isWritable,
      })),
      data: instruction.data,
    });

    await program.methods
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

    const finalAccount = await getAccount(provider.connection, inputTokenAccount.address);
    assert.equal(finalAccount.amount, 1_100n);
  });
});
