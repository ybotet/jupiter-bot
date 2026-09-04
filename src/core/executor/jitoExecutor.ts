import bs58 from 'bs58';
import { Keypair, VersionedTransaction, type Commitment } from '@solana/web3.js';

import { createSilentLogger, serializeError, type Logger } from '../../utils/logger';
import type { SignedBundle } from './bundleBuilder';

/** Máximo de transacciones por bundle admitidas por el block-engine de Jito. */
export const JITO_MAX_TX_PER_BUNDLE = 5;

/** Ventana por defecto (en bloques) para considerar un bundle como no confirmado. */
export const DEFAULT_CONFIRMATION_BLOCK_WINDOW = 3;

/** Intervalo por defecto (en ms) entre sondeos de estado de firma. */
export const DEFAULT_POLL_INTERVAL_MS = 400;

/** Resultado normalizado emitido por el stream de Jito para un bundle. */
export interface BundleResultEvent {
  bundleId: string;
  status: 'accepted' | 'rejected';
  slot?: number;
  validatorIdentity?: string;
  rejectionReason?: string;
}

/** Cliente mínimo requerido para enviar bundles y observar sus resultados. */
export interface JitoRelayClient {
  sendBundle(transactions: VersionedTransaction[]): Promise<string>;
  onBundleResult(
    successCallback: (result: BundleResultEvent) => void,
    errorCallback: (error: Error) => void,
  ): () => void;
}

/** Estado por firma devuelto por el RPC de Solana. */
export interface SignatureStatusValue {
  slot?: number;
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | string;
  err?: unknown | null;
}

/** Proveedor RPC utilizado para verificar la inclusión on-chain del bundle. */
export interface SignatureStatusProvider {
  getSignatureStatuses(
    signatures: string[],
  ): Promise<{ value: Array<SignatureStatusValue | null> }>;
  getBlockHeight(commitment?: Commitment): Promise<number>;
}

/** Opciones para instanciar el ejecutor Jito. */
export interface JitoExecutorOptions {
  relayClient: JitoRelayClient;
  connection: SignatureStatusProvider;
  confirmationBlockWindow?: number;
  pollIntervalMs?: number;
  /** Logger opcional para trazabilidad del bundle. */
  logger?: Logger;
}

/** Estado final devuelto tras enviar un bundle al relay. */
export type BundleSubmissionStatus = 'confirmed' | 'accepted' | 'rejected' | 'timeout';

/** Resultado completo con firmas y detalles del envío del bundle. */
export interface BundleSubmissionResult {
  bundleId: string;
  signatures: string[];
  status: BundleSubmissionStatus;
  slot?: number;
  validatorIdentity?: string;
  rejectionReason?: string;
}

/** Envía bundles firmados al relay Jito y confirma su inclusión en Solana. */
export class JitoExecutor {
  private readonly relayClient: JitoRelayClient;
  private readonly connection: SignatureStatusProvider;
  private readonly confirmationBlockWindow: number;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;

  /** Configura el ejecutor con el cliente Jito y el proveedor RPC de confirmación. */
  constructor(options: JitoExecutorOptions) {
    this.relayClient = options.relayClient;
    this.connection = options.connection;
    this.confirmationBlockWindow =
      options.confirmationBlockWindow ?? DEFAULT_CONFIRMATION_BLOCK_WINDOW;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.logger = options.logger ?? createSilentLogger();

    if (this.confirmationBlockWindow <= 0) {
      throw new Error('confirmationBlockWindow debe ser mayor que cero');
    }
    if (this.pollIntervalMs <= 0) {
      throw new Error('pollIntervalMs debe ser mayor que cero');
    }
  }

  /** Envía el bundle al relay y espera confirmación dentro de la ventana de bloques. */
  public async submit(bundle: SignedBundle): Promise<BundleSubmissionResult> {
    this.validateBundle(bundle);
    const signatures = bundle.transactions.map((tx) => extractFirstSignature(tx));

    let bundleResult: BundleResultEvent | undefined;
    let streamError: Error | undefined;
    const cancelListener = this.relayClient.onBundleResult(
      (event) => {
        bundleResult = event;
      },
      (error) => {
        streamError = error;
      },
    );

    try {
      const bundleId = await this.relayClient.sendBundle(bundle.transactions);
      this.logger.debug(
        {
          bundleId,
          signatures,
          lastValidBlockHeight: bundle.lastValidBlockHeight,
        },
        'jito:bundle-sent',
      );
      const result = await this.waitForConfirmation({
        bundleId,
        signatures,
        lastValidBlockHeight: bundle.lastValidBlockHeight,
        getBundleResult: () => bundleResult,
        getStreamError: () => streamError,
      });
      this.logResult(result);
      return result;
    } catch (error) {
      this.logger.warn(
        { err: serializeError(error) },
        'jito:submit-error',
      );
      throw error;
    } finally {
      safeCancel(cancelListener);
    }
  }

  /**
   * Registra el resultado final del bundle en el nivel de log adecuado
   * (info para éxito, warn para rechazo o timeout).
   */
  private logResult(result: BundleSubmissionResult): void {
    const payload = {
      bundleId: result.bundleId,
      status: result.status,
      slot: result.slot,
      validatorIdentity: result.validatorIdentity,
      rejectionReason: result.rejectionReason,
    };
    if (result.status === 'confirmed' || result.status === 'accepted') {
      this.logger.info(payload, 'jito:bundle-result');
    } else {
      this.logger.warn(payload, 'jito:bundle-result');
    }
  }

  /** Sondea el estado del bundle contra el RPC de Solana y el stream de Jito. */
  private async waitForConfirmation(context: {
    bundleId: string;
    signatures: string[];
    lastValidBlockHeight: number;
    getBundleResult: () => BundleResultEvent | undefined;
    getStreamError: () => Error | undefined;
  }): Promise<BundleSubmissionResult> {
    const { bundleId, signatures, lastValidBlockHeight, getBundleResult, getStreamError } = context;
    const startBlockHeight = await this.connection.getBlockHeight('processed');
    const targetBlockHeight = startBlockHeight + this.confirmationBlockWindow;

    // Se sondea repetidamente hasta que la firma se confirme o expire la ventana.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const streamError = getStreamError();
      if (streamError) {
        throw new Error(`El stream de Jito devolvió un error: ${streamError.message}`);
      }

      const confirmation = await this.checkSignatures(signatures);
      if (confirmation) {
        return {
          bundleId,
          signatures,
          status: 'confirmed',
          slot: confirmation.slot,
        };
      }

      const event = getBundleResult();
      if (event && event.status === 'rejected') {
        return {
          bundleId,
          signatures,
          status: 'rejected',
          rejectionReason: event.rejectionReason,
          slot: event.slot,
          validatorIdentity: event.validatorIdentity,
        };
      }

      const currentBlockHeight = await this.connection.getBlockHeight('processed');
      if (currentBlockHeight >= targetBlockHeight || currentBlockHeight > lastValidBlockHeight) {
        const finalConfirmation = await this.checkSignatures(signatures);
        if (finalConfirmation) {
          return {
            bundleId,
            signatures,
            status: 'confirmed',
            slot: finalConfirmation.slot,
          };
        }

        const finalEvent = getBundleResult();
        return {
          bundleId,
          signatures,
          status: finalEvent?.status === 'accepted' ? 'accepted' : 'timeout',
          slot: finalEvent?.slot,
          validatorIdentity: finalEvent?.validatorIdentity,
          rejectionReason: finalEvent?.rejectionReason,
        };
      }

      await sleep(this.pollIntervalMs);
    }
  }

  /** Comprueba si todas las firmas del bundle ya están confirmadas o finalizadas. */
  private async checkSignatures(signatures: string[]): Promise<{ slot?: number } | undefined> {
    const statuses = await this.connection.getSignatureStatuses(signatures);
    const values = statuses.value;

    if (values.length !== signatures.length) {
      return undefined;
    }

    let latestSlot: number | undefined;
    for (const status of values) {
      if (!status) {
        return undefined;
      }
      if (status.err) {
        throw new Error(
          `La transacción del bundle falló on-chain: ${JSON.stringify(status.err)}`,
        );
      }
      if (
        status.confirmationStatus !== 'confirmed' &&
        status.confirmationStatus !== 'finalized'
      ) {
        return undefined;
      }
      if (typeof status.slot === 'number') {
        latestSlot = Math.max(latestSlot ?? 0, status.slot);
      }
    }

    return { slot: latestSlot };
  }

  /** Valida las condiciones mínimas del bundle antes de enviarlo al relay. */
  private validateBundle(bundle: SignedBundle): void {
    if (!bundle.transactions || bundle.transactions.length === 0) {
      throw new Error('El bundle no contiene transacciones firmadas');
    }
    if (bundle.transactions.length > JITO_MAX_TX_PER_BUNDLE) {
      throw new Error(
        `Un bundle admite hasta ${JITO_MAX_TX_PER_BUNDLE} transacciones (recibidas ${bundle.transactions.length})`,
      );
    }
    for (const transaction of bundle.transactions) {
      if (!transaction.signatures || transaction.signatures.length === 0) {
        throw new Error('Todas las transacciones del bundle deben estar firmadas');
      }
    }
  }
}

/** Extrae la primera firma de una transacción versionada en base58. */
function extractFirstSignature(transaction: VersionedTransaction): string {
  const signature = transaction.signatures[0];
  if (!signature || signature.length === 0) {
    throw new Error('La transacción no contiene una firma válida');
  }
  return bs58.encode(signature);
}

/** Ejecuta el cancelador del listener protegiendo contra errores. */
function safeCancel(cancel: () => void): void {
  try {
    cancel();
  } catch {
    // No se registran errores del listener para no filtrar detalles sensibles.
  }
}

/** Pausa la ejecución durante el intervalo indicado. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Crea un JitoRelayClient real conectado al block-engine de Jito usando jito-ts.
 * La keypair se usa exclusivamente para autenticación gRPC y nunca se registra.
 */
export async function createSearcherRelayClient(
  url: string,
  authKeypair: Keypair,
): Promise<JitoRelayClient> {
  const { searcher, bundle } = await import('jito-ts/dist/sdk/block-engine');
  const client = searcher.searcherClient(url, authKeypair);

  return {
    sendBundle: async (transactions) => {
      if (transactions.length === 0) {
        throw new Error('No se puede enviar un bundle vacío al relay');
      }
      const jitoBundle = new bundle.Bundle(transactions, JITO_MAX_TX_PER_BUNDLE);
      return client.sendBundle(jitoBundle);
    },
    onBundleResult: (successCallback, errorCallback) => {
      return client.onBundleResult(
        (result) => successCallback(mapBundleResult(result)),
        errorCallback,
      );
    },
  };
}

/** Convierte el BundleResult crudo de jito-ts a la estructura interna del ejecutor. */
function mapBundleResult(result: {
  bundleId: string;
  accepted?: { slot?: number; validatorIdentity?: string };
  rejected?: unknown;
}): BundleResultEvent {
  if (result.accepted) {
    return {
      bundleId: result.bundleId,
      status: 'accepted',
      slot: result.accepted.slot,
      validatorIdentity: result.accepted.validatorIdentity,
    };
  }

  return {
    bundleId: result.bundleId,
    status: 'rejected',
    rejectionReason: extractRejectionReason(result.rejected),
  };
}

/** Extrae un motivo legible del rechazo devuelto por el block-engine. */
function extractRejectionReason(rejected: unknown): string | undefined {
  if (!rejected || typeof rejected !== 'object') {
    return undefined;
  }
  for (const [reasonKey, detail] of Object.entries(rejected as Record<string, unknown>)) {
    if (detail && typeof detail === 'object') {
      const detailRecord = detail as { msg?: string; txSignature?: string };
      if (detailRecord.msg || detailRecord.txSignature) {
        return `${reasonKey}: ${detailRecord.msg ?? detailRecord.txSignature}`;
      }
      return reasonKey;
    }
  }
  return undefined;
}


