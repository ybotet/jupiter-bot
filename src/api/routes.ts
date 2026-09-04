import { randomUUID } from 'node:crypto';

import { Router, type Request, type Response } from 'express';

import { createSilentLogger, type Logger } from '../utils/logger';
import { redactSensitiveFields } from '../utils/secrets';

/** Estado agregado del bot que se expone a través de la API REST. */
export interface BotStatus {
  /** Cadena legible: `starting | running | paused | stopped`. */
  state: BotState;
  /** Fecha ISO-8601 en la que el bot inició. `undefined` si aún no arrancó. */
  startedAt?: string;
  /** Marca temporal ISO-8601 del último ciclo de monitoreo completado. */
  lastHeartbeatAt?: string;
  /** Cluster de Solana sobre el que opera (`mainnet-beta | devnet | ...`). */
  cluster?: string;
  /** Versión declarada del bot (leída desde `package.json` por el consumidor). */
  version?: string;
  /** Métricas acumuladas de operación. Se serializan tal cual llegan. */
  metrics: BotMetrics;
}

/** Etiquetas de estado admitidas por el bot. */
export type BotState = 'starting' | 'running' | 'paused' | 'stopped';

/**
 * Métricas mínimas visibles por la API. Se mantienen numéricas para que
 * el dashboard pueda graficarlas sin transformaciones adicionales.
 */
export interface BotMetrics {
  /** Nº total de oportunidades detectadas por el `StrategyOrchestrator`. */
  opportunitiesDetected: number;
  /** Nº total de bundles enviados al relay de Jito. */
  bundlesSubmitted: number;
  /** Nº total de bundles confirmados on-chain. */
  bundlesConfirmed: number;
  /** Nº total de bundles rechazados o expirados. */
  bundlesFailed: number;
  /** Beneficio neto acumulado, expresado como string decimal en USDC. */
  netProfitUsdc: string;
}

/**
 * Contrato mínimo que debe implementar cualquier fuente de estado. Permite
 * que el `StrategyOrchestrator` y otros módulos publiquen su estado sin
 * acoplarse al transporte HTTP concreto.
 */
export interface BotStatusProvider {
  /** Devuelve una instantánea del estado actual del bot. */
  getStatus(): BotStatus;
}

/** Métricas por defecto usadas al crear un `InMemoryBotStatusProvider` vacío. */
export const DEFAULT_BOT_METRICS: BotMetrics = {
  opportunitiesDetected: 0,
  bundlesSubmitted: 0,
  bundlesConfirmed: 0,
  bundlesFailed: 0,
  netProfitUsdc: '0',
};

/**
 * Implementación por defecto del `BotStatusProvider` con almacenamiento en memoria.
 * Los módulos del cerebro pueden invocar `updateState` y `mergeMetrics` para
 * publicar cambios sin conocer el detalle del router HTTP.
 */
export class InMemoryBotStatusProvider implements BotStatusProvider {
  private status: BotStatus;

  /**
   * Construye un proveedor de estado en memoria con valores iniciales opcionales.
   * Los valores omitidos toman los defaults documentados en `DEFAULT_BOT_METRICS`.
   */
  constructor(initial: Partial<BotStatus> = {}) {
    this.status = {
      state: initial.state ?? 'starting',
      startedAt: initial.startedAt,
      lastHeartbeatAt: initial.lastHeartbeatAt,
      cluster: initial.cluster,
      version: initial.version,
      metrics: { ...DEFAULT_BOT_METRICS, ...(initial.metrics ?? {}) },
    };
  }

  /** Devuelve una copia profunda del estado para evitar mutaciones accidentales. */
  public getStatus(): BotStatus {
    return {
      ...this.status,
      metrics: { ...this.status.metrics },
    };
  }

  /** Actualiza la etiqueta de estado global y refresca la marca de heartbeat. */
  public updateState(state: BotState): void {
    this.status.state = state;
    this.status.lastHeartbeatAt = new Date().toISOString();
  }

  /** Fusiona nuevas métricas con las existentes sin sobrescribir campos no provistos. */
  public mergeMetrics(partial: Partial<BotMetrics>): void {
    this.status.metrics = { ...this.status.metrics, ...partial };
    this.status.lastHeartbeatAt = new Date().toISOString();
  }

  /** Registra un latido de vida sin cambiar métricas ni estado. */
  public heartbeat(): void {
    this.status.lastHeartbeatAt = new Date().toISOString();
  }
}

/**
 * Registro individual de una oportunidad de arbitraje detectada por el
 * `StrategyOrchestrator`. Se expone a través de la API para que el dashboard
 * pueda pintar el flujo en tiempo real sin acoplarse al buffer interno del
 * cerebro off-chain. Los importes se serializan como cadenas decimales para
 * no perder precisión al viajar por JSON.
 */
export interface DetectedOpportunity {
  /** Identificador único de la oportunidad. Se usa como key en React. */
  id: string;
  /** Marca temporal ISO-8601 en la que se detectó la oportunidad. */
  detectedAt: string;
  /** Descripción legible de la ruta (p. ej. `SOL → USDC → USDT → SOL`). */
  route: string;
  /** Beneficio bruto estimado antes de comisiones, en USDC (decimal string). */
  grossProfitUsdc: string;
  /** Beneficio neto estimado (grossProfit − fees − tip − slippage), en USDC. */
  netProfitUsdc: string;
  /** Basis points de slippage tolerado en la ruta (0-10 000). */
  slippageBps: number;
  /** Estado operativo de la oportunidad al momento del registro. */
  status: OpportunityStatus;
  /** Identificador de la transacción asociada (si ya se firmó/envió). */
  transactionId?: string;
  /** Motivo por el que se descartó la oportunidad, si aplica. */
  reason?: string;
}

/** Estados válidos de una oportunidad en su ciclo de vida. */
export type OpportunityStatus =
  | 'detected'
  | 'submitted'
  | 'confirmed'
  | 'rejected'
  | 'expired';

/**
 * Contrato mínimo del feed de oportunidades. Permite que el
 * `StrategyOrchestrator` publique detecciones sin acoplarse al transporte HTTP.
 */
export interface OpportunityFeed {
  /**
   * Devuelve las oportunidades más recientes ordenadas por `detectedAt`
   * descendente. Si se pasa `since`, filtra las anteriores o iguales a esa
   * marca temporal (ISO-8601). Si se pasa `limit`, corta el resultado a esa
   * cantidad (con un máximo interno de 100 entradas por respuesta).
   */
  getRecent(options?: { since?: string; limit?: number }): DetectedOpportunity[];
}

/** Tamaño máximo del buffer circular del feed en memoria. */
export const DEFAULT_OPPORTUNITY_BUFFER_SIZE = 200;

/** Límite duro de entradas devueltas por consulta al endpoint. */
export const MAX_OPPORTUNITIES_PER_QUERY = 100;

/**
 * Implementación por defecto del `OpportunityFeed` con buffer circular en
 * memoria. Aplica descarte FIFO al superar la capacidad para acotar el uso
 * de RAM ante ráfagas prolongadas de detecciones.
 */
export class InMemoryOpportunityFeed implements OpportunityFeed {
  private readonly buffer: DetectedOpportunity[] = [];

  /**
   * Construye un feed en memoria con la capacidad indicada. La capacidad
   * mínima es 1 (valores inferiores se ajustan al default) para evitar que
   * un consumidor lo instancie deshabilitado por accidente.
   */
  constructor(private readonly capacity: number = DEFAULT_OPPORTUNITY_BUFFER_SIZE) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      this.capacity = DEFAULT_OPPORTUNITY_BUFFER_SIZE;
    }
  }

  /**
   * Registra una oportunidad detectada. Autocompleta `id` (UUID v4) y
   * `detectedAt` (fecha ISO actual) si el consumidor los omite, para que el
   * `StrategyOrchestrator` pueda emitir con la mínima ceremonia posible.
   */
  public record(entry: Partial<DetectedOpportunity> & Pick<DetectedOpportunity, 'route' | 'grossProfitUsdc' | 'netProfitUsdc' | 'slippageBps'>): DetectedOpportunity {
    const normalized: DetectedOpportunity = {
      id: entry.id ?? randomUUID(),
      detectedAt: entry.detectedAt ?? new Date().toISOString(),
      route: entry.route,
      grossProfitUsdc: entry.grossProfitUsdc,
      netProfitUsdc: entry.netProfitUsdc,
      slippageBps: entry.slippageBps,
      status: entry.status ?? 'detected',
      transactionId: entry.transactionId,
      reason: entry.reason,
    };
    this.buffer.push(normalized);
    // Descarte FIFO: mantenemos como mucho `capacity` entradas.
    while (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
    return normalized;
  }

  /**
   * Devuelve las oportunidades más recientes, opcionalmente filtradas por
   * `since` (ISO-8601 estricto) y acotadas por `limit` (máx. 100). El
   * resultado siempre está ordenado por `detectedAt` descendente.
   */
  public getRecent(options: { since?: string; limit?: number } = {}): DetectedOpportunity[] {
    const sinceMs = parseIsoDate(options.since);
    const filtered = this.buffer.filter((entry) => {
      if (sinceMs === null) return true;
      const entryMs = Date.parse(entry.detectedAt);
      return Number.isFinite(entryMs) && entryMs > sinceMs;
    });
    // Copia y orden descendente por `detectedAt` para no mutar el buffer.
    const sorted = filtered
      .slice()
      .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
    const cap = Math.min(
      Math.max(1, options.limit ?? MAX_OPPORTUNITIES_PER_QUERY),
      MAX_OPPORTUNITIES_PER_QUERY,
    );
    return sorted.slice(0, cap);
  }

  /** Vacía el buffer. Útil en tests y en escenarios de reset controlado. */
  public clear(): void {
    this.buffer.length = 0;
  }

  /** Devuelve cuántas entradas viven actualmente en el buffer. */
  public size(): number {
    return this.buffer.length;
  }
}

/**
 * Parsea una fecha ISO-8601 devolviendo su timestamp en milisegundos.
 * Retorna `null` si la entrada está ausente, vacía o mal formada, para que
 * el filtro `since` degrade con seguridad a "sin filtro".
 */
function parseIsoDate(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Opciones de configuración para el router de la API pública del bot. */
export interface RegisterBotRoutesOptions {
  /** Proveedor de estado inyectado; obligatorio para servir `GET /status`. */
  statusProvider: BotStatusProvider;
  /**
   * Feed opcional de oportunidades detectadas. Si se omite, el endpoint
   * `GET /opportunities` responde con una lista vacía en lugar de 404 para
   * que el frontend pueda sondearlo sin ramas condicionales.
   */
  opportunityFeed?: OpportunityFeed;
  /** Logger opcional (por defecto silencioso) para trazar accesos a la API. */
  logger?: Logger;
}

/**
 * Registra las rutas REST del bot sobre un `Router` de Express y devuelve
 * ese mismo router para poder montarlo en la aplicación principal.
 */
export function registerBotRoutes(options: RegisterBotRoutesOptions): Router {
  if (!options.statusProvider) {
    throw new Error('registerBotRoutes: statusProvider es obligatorio');
  }
  const logger = options.logger ?? createSilentLogger();
  const router = Router();

  // GET /status: instantánea del estado del bot.
  router.get('/status', (req: Request, res: Response) => {
    const snapshot = options.statusProvider.getStatus();
    logger.debug({ route: 'GET /status' }, 'api:status');
    // Aplicamos saneamiento defensivo: si algún proveedor futuro incluye
    // campos sensibles por accidente, no salen por la API.
    res.status(200).json(redactSensitiveFields(snapshot));
  });

  // GET /opportunities: feed de oportunidades detectadas (Tarea 6.4).
  // Acepta `?since=<ISO>` para deltas incrementales y `?limit=<n>` (máx 100).
  router.get('/opportunities', (req: Request, res: Response) => {
    const feed = options.opportunityFeed;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const limit =
      typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
    const items = feed
      ? feed.getRecent({ since, limit: Number.isFinite(limit ?? NaN) ? limit : undefined })
      : [];
    logger.debug(
      { route: 'GET /opportunities', since, limit, returned: items.length },
      'api:opportunities',
    );
    res.status(200).json({
      items: redactSensitiveFields(items) as DetectedOpportunity[],
      count: items.length,
      generatedAt: new Date().toISOString(),
    });
  });

  // GET /health: endpoint ligero para probes de liveness/readiness.
  router.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return router;
}
