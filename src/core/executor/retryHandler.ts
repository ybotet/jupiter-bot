import type { SignedBundle } from './bundleBuilder';
import type { BundleSubmissionResult, BundleSubmissionStatus } from './jitoExecutor';

/** Precio inicial por defecto en microLamports por unidad de cómputo. */
export const DEFAULT_INITIAL_COMPUTE_UNIT_PRICE = 1_000;

/** Multiplicador por defecto aplicado al computeUnitPrice entre reintentos (+10%). */
export const DEFAULT_COMPUTE_UNIT_PRICE_MULTIPLIER = 1.1;

/** Número máximo de intentos por defecto (incluye el primer envío). */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** Backoff inicial por defecto entre reintentos (250 ms). */
export const DEFAULT_INITIAL_BACKOFF_MS = 250;

/** Factor por defecto para el backoff exponencial entre reintentos. */
export const DEFAULT_BACKOFF_MULTIPLIER = 2;

/** Factoría que genera un SignedBundle listo para enviar con un computeUnitPrice concreto. */
export type BundleFactory = (computeUnitPrice: number) => Promise<SignedBundle>;

/** Contrato mínimo del componente que envía bundles al relay (implementado por JitoExecutor). */
export interface BundleSubmitter {
  submit(bundle: SignedBundle): Promise<BundleSubmissionResult>;
}

/** Opciones que controlan la política de reintentos y el escalado del computeUnitPrice. */
export interface RetryHandlerOptions {
  maxAttempts?: number;
  initialComputeUnitPrice?: number;
  computeUnitPriceMultiplier?: number;
  initialBackoffMs?: number;
  backoffMultiplier?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

/** Detalle de un intento individual para poder auditar reintentos posteriormente. */
export interface RetryAttempt {
  attempt: number;
  computeUnitPrice: number;
  status: BundleSubmissionStatus | 'error';
  bundleId?: string;
  rejectionReason?: string;
  error?: string;
}

/** Resultado agregado con el desenlace final y el historial completo de intentos. */
export interface RetryOutcome {
  finalStatus: BundleSubmissionStatus | 'error';
  attempts: number;
  computeUnitPrice: number;
  bundleId?: string;
  signatures?: string[];
  rejectionReason?: string;
  history: RetryAttempt[];
}


/** Estados finales que no requieren reintento porque el bundle ya está resuelto. */
const TERMINAL_SUCCESS_STATES = new Set<BundleSubmissionStatus>(['confirmed', 'accepted']);

/**
 * Orquesta el reenvío del bundle con `computeUnitPrice` creciente y backoff exponencial
 * cuando el envío anterior no se confirma dentro de la ventana de bloques o es rechazado.
 */
export class RetryHandler {
  private readonly submitter: BundleSubmitter;
  private readonly maxAttempts: number;
  private readonly initialComputeUnitPrice: number;
  private readonly computeUnitPriceMultiplier: number;
  private readonly initialBackoffMs: number;
  private readonly backoffMultiplier: number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  /** Configura la política de reintentos con valores por defecto seguros para producción. */
  constructor(submitter: BundleSubmitter, options: RetryHandlerOptions = {}) {
    this.submitter = submitter;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.initialComputeUnitPrice =
      options.initialComputeUnitPrice ?? DEFAULT_INITIAL_COMPUTE_UNIT_PRICE;
    this.computeUnitPriceMultiplier =
      options.computeUnitPriceMultiplier ?? DEFAULT_COMPUTE_UNIT_PRICE_MULTIPLIER;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.backoffMultiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    this.sleepFn = options.sleepFn ?? defaultSleep;

    if (this.maxAttempts <= 0) {
      throw new Error('maxAttempts debe ser mayor que cero');
    }
    if (this.initialComputeUnitPrice <= 0) {
      throw new Error('initialComputeUnitPrice debe ser mayor que cero');
    }
    if (this.computeUnitPriceMultiplier <= 1) {
      throw new Error('computeUnitPriceMultiplier debe ser mayor que uno para escalar el precio');
    }
    if (this.initialBackoffMs < 0) {
      throw new Error('initialBackoffMs no puede ser negativo');
    }
    if (this.backoffMultiplier <= 0) {
      throw new Error('backoffMultiplier debe ser mayor que cero');
    }
  }

  /**
   * Intenta enviar el bundle hasta agotar `maxAttempts`, escalando el `computeUnitPrice`
   * y aplicando backoff exponencial. Devuelve el desenlace agregado con historial.
   */
  public async execute(bundleFactory: BundleFactory): Promise<RetryOutcome> {
    const history: RetryAttempt[] = [];
    let computeUnitPrice = this.initialComputeUnitPrice;
    let backoffMs = this.initialBackoffMs;
    let lastResult: BundleSubmissionResult | undefined;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const currentComputeUnitPrice = Math.ceil(computeUnitPrice);
      try {
        const bundle = await bundleFactory(currentComputeUnitPrice);
        const result = await this.submitter.submit(bundle);
        history.push({
          attempt,
          computeUnitPrice: currentComputeUnitPrice,
          status: result.status,
          bundleId: result.bundleId,
          rejectionReason: result.rejectionReason,
        });

        if (TERMINAL_SUCCESS_STATES.has(result.status)) {
          return {
            finalStatus: result.status,
            attempts: attempt,
            computeUnitPrice: currentComputeUnitPrice,
            bundleId: result.bundleId,
            signatures: result.signatures,
            history,
          };
        }

        lastResult = result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        history.push({
          attempt,
          computeUnitPrice: currentComputeUnitPrice,
          status: 'error',
          error: errorMessage,
        });
        lastError = error instanceof Error ? error : new Error(errorMessage);
      }

      if (attempt < this.maxAttempts) {
        if (backoffMs > 0) {
          await this.sleepFn(backoffMs);
          backoffMs *= this.backoffMultiplier;
        }
        computeUnitPrice *= this.computeUnitPriceMultiplier;
      }
    }

    // Se agotaron los reintentos: se propaga el último error o el último estado no exitoso.
    if (lastResult) {
      return {
        finalStatus: lastResult.status,
        attempts: this.maxAttempts,
        computeUnitPrice: Math.ceil(computeUnitPrice),
        bundleId: lastResult.bundleId,
        signatures: lastResult.signatures,
        rejectionReason: lastResult.rejectionReason,
        history,
      };
    }

    throw new Error(
      `Reintentos agotados sin recibir respuesta del relay: ${lastError?.message ?? 'error desconocido'}`,
    );
  }
}

/** Implementación por defecto del `sleep` para no depender de temporizadores globales fuera de tests. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
