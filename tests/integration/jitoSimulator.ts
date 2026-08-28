/**
 * Simulador en proceso de un relay Jito.
 *
 * Implementa el contrato `JitoRelayClient` que consume `JitoExecutor`,
 * pero mantiene el estado en memoria y expone hooks explícitos para que las
 * pruebas de integración disparen los distintos desenlaces posibles (aceptado,
 * rechazado, timeout, error del stream) sin necesidad de gRPC ni de la
 * infraestructura real de Jito.
 *
 * Convenciones del proyecto:
 * - No se registran datos sensibles del bundle (firmas, claves, IDL): los logs
 *   internos se limitan a metadatos anonimizados (identificador y contador).
 * - Se genera un `bundleId` pseudo-aleatorio con `crypto.randomUUID()` para que
 *   los tests puedan correlacionar envíos y respuestas sin colisiones.
 */

import { randomUUID } from 'node:crypto';

import type { VersionedTransaction } from '@solana/web3.js';

import type {
  BundleResultEvent,
  JitoRelayClient,
} from '../../src/core/executor/jitoExecutor';

/** Modos de respuesta soportados por el simulador. */
export type JitoSimulatorMode =
  | 'accepted'
  | 'rejected'
  | 'silent'
  | 'sendFailure'
  | 'streamError';

/** Configuración inyectada al construir el simulador. */
export interface JitoSimulatorOptions {
  /**
   * Modo de respuesta por defecto. Puede sobrescribirse en runtime con
   * `queueMode` para simular fallos transitorios entre reintentos.
   */
  mode?: JitoSimulatorMode;
  /** Motivo que se propaga cuando el modo activo es `rejected`. */
  rejectionReason?: string;
  /** Slot que se emite junto a los eventos aceptados/rechazados. */
  slot?: number;
  /** Identidad del validador que se propaga en el evento. */
  validatorIdentity?: string;
  /** Error del stream para el modo `streamError`. */
  streamErrorMessage?: string;
  /**
   * Ms de retraso antes de emitir el evento al listener registrado.
   * Sirve para verificar interacciones con el sondeo del ejecutor.
   */
  emitDelayMs?: number;
}

/** Registro de una interacción con el simulador (útil para aserciones). */
export interface SimulatorInteraction {
  bundleId: string;
  transactionCount: number;
  mode: JitoSimulatorMode;
  timestamp: number;
}

/**
 * Cliente Jito simulado que persiste los bundles enviados y ofrece helpers
 * para inspeccionar el flujo end-to-end desde las pruebas.
 */
export class JitoSimulator implements JitoRelayClient {
  private readonly interactions: SimulatorInteraction[] = [];
  private readonly listeners: Array<{
    success: (event: BundleResultEvent) => void;
    failure: (error: Error) => void;
  }> = [];
  private readonly queuedModes: JitoSimulatorMode[] = [];
  private readonly options: Required<
    Pick<
      JitoSimulatorOptions,
      'mode' | 'rejectionReason' | 'slot' | 'validatorIdentity' | 'streamErrorMessage' | 'emitDelayMs'
    >
  >;

  /** Configura el simulador con valores por defecto seguros para test. */
  constructor(options: JitoSimulatorOptions = {}) {
    this.options = {
      mode: options.mode ?? 'accepted',
      rejectionReason: options.rejectionReason ?? 'stateAuctionBidRejected',
      slot: options.slot ?? 1234,
      validatorIdentity: options.validatorIdentity ?? 'simulated-validator',
      streamErrorMessage: options.streamErrorMessage ?? 'stream disconnected',
      emitDelayMs: options.emitDelayMs ?? 0,
    };
  }

  /**
   * Encola un modo puntual que se consumirá en el próximo `sendBundle`,
   * permitiendo simular secuencias (por ejemplo: primero `silent` y luego
   * `accepted`) para probar la política de reintentos.
   */
  public queueMode(mode: JitoSimulatorMode): void {
    this.queuedModes.push(mode);
  }

  /** Devuelve una copia del historial de interacciones para asserts. */
  public getInteractions(): readonly SimulatorInteraction[] {
    return [...this.interactions];
  }

  /** Reinicia el estado en memoria del simulador entre casos de prueba. */
  public reset(): void {
    this.interactions.length = 0;
    this.queuedModes.length = 0;
    this.listeners.length = 0;
  }

  /** Envía un bundle simulado y programa el evento asíncrono correspondiente. */
  public async sendBundle(transactions: VersionedTransaction[]): Promise<string> {
    const mode = this.queuedModes.shift() ?? this.options.mode;

    if (mode === 'sendFailure') {
      throw new Error('relay unreachable: simulated send failure');
    }

    const bundleId = randomUUID();
    this.interactions.push({
      bundleId,
      transactionCount: transactions.length,
      mode,
      timestamp: Date.now(),
    });

    // Se difiere la emisión para respetar la semántica del stream gRPC real,
    // donde el evento nunca es síncrono con el `sendBundle`.
    this.scheduleEmission(bundleId, mode);

    return bundleId;
  }

  /** Registra los callbacks del listener y devuelve el cancelador. */
  public onBundleResult(
    successCallback: (event: BundleResultEvent) => void,
    errorCallback: (error: Error) => void,
  ): () => void {
    const entry = { success: successCallback, failure: errorCallback };
    this.listeners.push(entry);
    return () => {
      const index = this.listeners.indexOf(entry);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /** Programa la emisión del evento en función del modo activo. */
  private scheduleEmission(bundleId: string, mode: JitoSimulatorMode): void {
    if (mode === 'silent') {
      // Nunca se emite un evento: reproduce el timeout del block-engine.
      return;
    }

    const notify = (): void => {
      if (mode === 'streamError') {
        for (const listener of this.listeners) {
          listener.failure(new Error(this.options.streamErrorMessage));
        }
        return;
      }

      const event: BundleResultEvent = {
        bundleId,
        status: mode === 'accepted' ? 'accepted' : 'rejected',
        slot: this.options.slot,
        validatorIdentity: this.options.validatorIdentity,
        rejectionReason: mode === 'rejected' ? this.options.rejectionReason : undefined,
      };
      for (const listener of this.listeners) {
        listener.success(event);
      }
    };

    if (this.options.emitDelayMs > 0) {
      const timer = setTimeout(notify, this.options.emitDelayMs);
      timer.unref?.();
    } else {
      // Se usa un microtask para desacoplar la emisión del `sendBundle`.
      queueMicrotask(notify);
    }
  }
}

