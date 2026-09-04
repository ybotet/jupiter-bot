import { BorshInstructionCoder } from '@coral-xyz/anchor';
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import {
  collectRemainingAccounts,
  MEV_EXECUTOR_IDL,
  TOKEN_PROGRAM_ID,
  toAnchorArbitrageParams,
  toAnchorSwapInstruction,
  type ArbitrageBundleRequest,
} from '../../contracts/anchor/mevExecutor';
import { createSilentLogger, type Logger } from '../../utils/logger';
import { loadKeypair, loadKeypairFromEnv, PRIVATE_KEY_ENV } from '../../utils/secrets';

export interface BlockhashProvider {
  getLatestBlockhash(commitment?: 'processed' | 'confirmed' | 'finalized'): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
}

export interface BundleBuilderOptions {
  connection: BlockhashProvider;
  payer?: Keypair;
  privateKey?: string;
  programId: PublicKey;
  /** Logger opcional; si no se inyecta se usa uno silencioso para no acoplar al transporte. */
  logger?: Logger;
}

export interface SignedBundle {
  transactions: VersionedTransaction[];
  payer: PublicKey;
  lastValidBlockHeight: number;
}

const EXECUTE_ARBITRAGE_DISCRIMINATOR = Buffer.from([63, 57, 76, 143, 41, 52, 112, 208]);

/** Construye transacciones firmadas que posteriormente puede enviar el ejecutor Jito. */
export class BundleBuilder {
  private readonly connection: BlockhashProvider;
  private readonly payer: Keypair;
  private readonly programId: PublicKey;
  private readonly instructionCoder = new BorshInstructionCoder(MEV_EXECUTOR_IDL);
  private readonly logger: Logger;

  /** Crea el builder usando una cartera inyectada o la clave privada del entorno. */
  constructor(options: BundleBuilderOptions) {
    this.connection = options.connection;
    this.payer =
      options.payer ??
      (options.privateKey ? loadKeypair(options.privateKey) : loadKeypairFromEnv(PRIVATE_KEY_ENV));
    this.programId = options.programId;
    this.logger = options.logger ?? createSilentLogger();
  }

  /**
   * Construye la instrucción Anchor execute_arbitrage con compra y venta secuenciadas
   * dentro de una única invocación atómica al contrato.
   */
  public buildExecuteArbitrageInstruction(request: ArbitrageBundleRequest): TransactionInstruction {
    this.validateSwapInstruction(request.buyInstruction, 'compra');
    this.validateSwapInstruction(request.sellInstruction, 'venta');

    const encodedInstruction = this.instructionCoder.encode('execute_arbitrage', {
      params: toAnchorArbitrageParams(request.params),
      buyInstruction: toAnchorSwapInstruction(request.buyInstruction),
      sellInstruction: toAnchorSwapInstruction(request.sellInstruction),
    });

    if (!encodedInstruction) {
      throw new Error('No se pudo codificar la instrucción execute_arbitrage');
    }

    const remainingAccounts = collectRemainingAccounts(
      request.buyInstruction,
      request.sellInstruction,
    );

    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: request.accounts.state, isSigner: false, isWritable: true },
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: request.accounts.inputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: request.accounts.outputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ...remainingAccounts,
      ],
      data: Buffer.from(encodedInstruction),
    });
  }

  /** Construye y firma un bundle con la instrucción atómica de arbitraje. */
  public async buildArbitrageBundle(request: ArbitrageBundleRequest): Promise<SignedBundle> {
    const instruction = this.buildExecuteArbitrageInstruction(request);
    return this.build([[instruction]]);
  }

  /** Construye y firma un bundle de transacciones sin enviarlo a la red. */
  public async build(instructions: TransactionInstruction[][]): Promise<SignedBundle> {
    if (instructions.length === 0) {
      throw new Error('El bundle debe contener al menos una transacción');
    }

    for (const transactionInstructions of instructions) {
      this.validateInstructions(transactionInstructions);
    }

    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('processed');
    const transactions = instructions.map((transactionInstructions) => {
      const message = new TransactionMessage({
        payerKey: this.payer.publicKey,
        recentBlockhash: blockhash,
        instructions: transactionInstructions,
      }).compileToV0Message();
      const transaction = new VersionedTransaction(message);
      transaction.sign([this.payer]);
      return transaction;
    });

    this.logger.debug(
      {
        transactionsCount: transactions.length,
        lastValidBlockHeight,
      },
      'bundle:signed',
    );

    return {
      transactions,
      payer: this.payer.publicKey,
      lastValidBlockHeight,
    };
  }

  /** Devuelve la cartera pública usada para firmar el bundle. */
  public getPayer(): PublicKey {
    return this.payer.publicKey;
  }

  /** Valida que todas las instrucciones pertenezcan al programa Anchor configurado. */
  private validateInstructions(instructions: TransactionInstruction[]): void {
    if (instructions.length === 0) {
      throw new Error('Cada transacción debe contener al menos una instrucción');
    }

    if (instructions.some((instruction) => !instruction.programId.equals(this.programId))) {
      throw new Error('El bundle contiene una instrucción de un programa no autorizado');
    }
  }

  /** Valida que una instrucción CPI de swap tenga datos mínimos utilizables on-chain. */
  private validateSwapInstruction(
    swap: ArbitrageBundleRequest['buyInstruction'],
    label: 'compra' | 'venta',
  ): void {
    if (swap.programId.equals(PublicKey.default)) {
      throw new Error(`La instrucción de ${label} no tiene un programa válido`);
    }

    if (swap.accounts.length === 0) {
      throw new Error(`La instrucción de ${label} no contiene cuentas`);
    }

    if (swap.data.length === 0) {
      throw new Error(`La instrucción de ${label} no contiene datos`);
    }
  }
}

export { EXECUTE_ARBITRAGE_DISCRIMINATOR };

