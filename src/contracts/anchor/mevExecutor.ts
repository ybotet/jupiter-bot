import { PublicKey, type AccountMeta } from '@solana/web3.js';
import type { Idl } from '@coral-xyz/anchor';

export const MEV_EXECUTOR_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** Parámetros de arbitraje serializados hacia el contrato Anchor. */
export interface ArbitrageParams {
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputAmount: bigint;
  expectedOutputAmount: bigint;
  minimumOutputAmount: bigint;
  gasEstimated: bigint;
  jupiterFeesEstimated: bigint;
  jitoTipEstimated: bigint;
  maximumSlippageBps: number;
}

/** Metadatos de cuenta requeridos por un CPI de swap externo. */
export interface SwapAccountMeta {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
}

/** Datos de una instrucción CPI de swap embebida en execute_arbitrage. */
export interface SwapInstructionData {
  programId: PublicKey;
  accounts: SwapAccountMeta[];
  data: Uint8Array;
}

/** Cuentas fijas necesarias para invocar execute_arbitrage. */
export interface ExecuteArbitrageAccounts {
  state: PublicKey;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
}

/** Petición completa para construir un bundle de arbitraje atómico. */
export interface ArbitrageBundleRequest {
  accounts: ExecuteArbitrageAccounts;
  params: ArbitrageParams;
  buyInstruction: SwapInstructionData;
  sellInstruction: SwapInstructionData;
}

/** IDL mínima del programa mev_executor para codificar instrucciones off-chain. */
export const MEV_EXECUTOR_IDL = {
  address: MEV_EXECUTOR_PROGRAM_ID.toBase58(),
  metadata: {
    name: 'mev_executor',
    version: '0.1.0',
    spec: '0.1.0',
  },
  instructions: [
    {
      name: 'execute_arbitrage',
      discriminator: [63, 57, 76, 143, 41, 52, 112, 208],
      accounts: [
        { name: 'state', writable: true },
        { name: 'authority', signer: true },
        { name: 'input_token_account', writable: true },
        { name: 'output_token_account', writable: true },
        { name: 'token_program' },
      ],
      args: [
        { name: 'params', type: { defined: { name: 'ArbitrageParams' } } },
        { name: 'buy_instruction', type: { defined: { name: 'SwapInstructionData' } } },
        { name: 'sell_instruction', type: { defined: { name: 'SwapInstructionData' } } },
      ],
    },
  ],
  types: [
    {
      name: 'ArbitrageParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'input_mint', type: 'pubkey' },
          { name: 'output_mint', type: 'pubkey' },
          { name: 'input_amount', type: 'u64' },
          { name: 'expected_output_amount', type: 'u64' },
          { name: 'minimum_output_amount', type: 'u64' },
          { name: 'gas_estimated', type: 'u64' },
          { name: 'jupiter_fees_estimated', type: 'u64' },
          { name: 'jito_tip_estimated', type: 'u64' },
          { name: 'maximum_slippage_bps', type: 'u16' },
        ],
      },
    },
    {
      name: 'SwapAccountMeta',
      type: {
        kind: 'struct',
        fields: [
          { name: 'pubkey', type: 'pubkey' },
          { name: 'is_signer', type: 'bool' },
          { name: 'is_writable', type: 'bool' },
        ],
      },
    },
    {
      name: 'SwapInstructionData',
      type: {
        kind: 'struct',
        fields: [
          { name: 'program_id', type: 'pubkey' },
          { name: 'accounts', type: { vec: { defined: { name: 'SwapAccountMeta' } } } },
          { name: 'data', type: 'bytes' },
        ],
      },
    },
  ],
} as const satisfies Idl;

/** Recopila las cuentas CPI únicas exigidas por la compra y la venta. */
export function collectRemainingAccounts(
  buyInstruction: SwapInstructionData,
  sellInstruction: SwapInstructionData,
): AccountMeta[] {
  const remainingAccounts: AccountMeta[] = [];
  const seenKeys = new Set<string>();

  const appendSwapAccounts = (swap: SwapInstructionData): void => {
    const programKey = swap.programId.toBase58();
    if (!seenKeys.has(programKey)) {
      remainingAccounts.push({
        pubkey: swap.programId,
        isSigner: false,
        isWritable: false,
      });
      seenKeys.add(programKey);
    }

    for (const account of swap.accounts) {
      const accountKey = account.pubkey.toBase58();
      if (seenKeys.has(accountKey)) {
        continue;
      }

      remainingAccounts.push({
        pubkey: account.pubkey,
        isSigner: account.isSigner,
        isWritable: account.isWritable,
      });
      seenKeys.add(accountKey);
    }
  };

  appendSwapAccounts(buyInstruction);
  appendSwapAccounts(sellInstruction);

  return remainingAccounts;
}

/** Convierte los tipos internos al formato esperado por el codificador Anchor. */
export function toAnchorSwapInstruction(swap: SwapInstructionData): {
  programId: PublicKey;
  accounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
  data: Buffer;
} {
  return {
    programId: swap.programId,
    accounts: swap.accounts.map((account) => ({
      pubkey: account.pubkey,
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(swap.data),
  };
}

/** Convierte ArbitrageParams al formato de argumentos del codificador Anchor. */
export function toAnchorArbitrageParams(params: ArbitrageParams): {
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputAmount: bigint;
  expectedOutputAmount: bigint;
  minimumOutputAmount: bigint;
  gasEstimated: bigint;
  jupiterFeesEstimated: bigint;
  jitoTipEstimated: bigint;
  maximumSlippageBps: number;
} {
  return {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    inputAmount: params.inputAmount,
    expectedOutputAmount: params.expectedOutputAmount,
    minimumOutputAmount: params.minimumOutputAmount,
    gasEstimated: params.gasEstimated,
    jupiterFeesEstimated: params.jupiterFeesEstimated,
    jitoTipEstimated: params.jitoTipEstimated,
    maximumSlippageBps: params.maximumSlippageBps,
  };
}
