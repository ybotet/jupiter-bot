/**
 * Cliente HTTP del dashboard para consumir la API del bot (Tarea 6.4).
 *
 * Este archivo cumple literalmente el criterio de aceptación de la Tarea 6.4:
 *   "Conectar el frontend con la API del backend para mostrar oportunidades
 *   en tiempo real".
 *
 * Se aísla la capa de acceso a red aquí para que `app.tsx` no dependa
 * directamente de `fetch` ni de la forma de las URLs. Todas las funciones
 * aceptan un `AbortSignal` opcional para poder cancelar peticiones en vuelo
 * cuando el componente que las lanzó se desmonta o cuando el intervalo de
 * polling se reinicia con una `apiBaseUrl` distinta.
 *
 * Los tipos declarados aquí espejan los del backend
 * (`src/api/routes.ts::BotStatus` y `DetectedOpportunity`) pero se duplican
 * intencionalmente para que la compilación del frontend con
 * `tsconfig.web.json` no arrastre módulos Node (`express`, `pino`, `crypto`).
 */

/** Etiquetas de estado que expone la API. */
export type BotState = 'starting' | 'running' | 'paused' | 'stopped';

/** Métricas agregadas que la API adjunta en cada `GET /status`. */
export interface BotMetrics {
  opportunitiesDetected: number;
  bundlesSubmitted: number;
  bundlesConfirmed: number;
  bundlesFailed: number;
  netProfitUsdc: string;
}

/** Instantánea completa del estado del bot devuelta por `GET /api/status`. */
export interface BotStatus {
  state: BotState;
  startedAt?: string;
  lastHeartbeatAt?: string;
  cluster?: string;
  version?: string;
  metrics: BotMetrics;
}

/** Estados posibles de una oportunidad detectada. */
export type OpportunityStatus =
  | 'detected'
  | 'submitted'
  | 'confirmed'
  | 'rejected'
  | 'expired';

/**
 * Contrato de cada oportunidad emitida por `GET /api/opportunities`.
 * Los importes se manejan como cadenas decimales para preservar la precisión
 * financiera calculada con `Decimal.js` en el backend.
 */
export interface DetectedOpportunity {
  id: string;
  detectedAt: string;
  route: string;
  grossProfitUsdc: string;
  netProfitUsdc: string;
  slippageBps: number;
  status: OpportunityStatus;
  transactionId?: string;
  reason?: string;
}

/** Respuesta del endpoint `GET /api/opportunities`. */
export interface OpportunitiesResponse {
  items: DetectedOpportunity[];
  count: number;
  generatedAt: string;
}

/** Opciones aceptadas al construir un cliente vía `createBotApiClient`. */
export interface BotApiClientOptions {
  /**
   * URL base del backend. Cadena vacía (por defecto) hace que las peticiones
   * viajen al mismo origen que sirve el HTML — el modo esperado cuando el
   * servidor Express monta el frontend estático.
   */
  baseUrl?: string;
  /**
   * Implementación de `fetch` a usar. Inyectable para poder testar el cliente
   * en Node sin `jsdom`. Por defecto usa el `fetch` global del navegador.
   */
  fetchImpl?: typeof fetch;
}

/** Opciones runtime aceptadas por cada método del cliente. */
export interface RequestOptions {
  /** Señal de aborto para cancelar la petición HTTP. */
  signal?: AbortSignal;
}

/** Opciones específicas para pedir oportunidades incrementalmente. */
export interface FetchOpportunitiesOptions extends RequestOptions {
  /**
   * ISO-8601 estricto. Si se envía, la API devuelve sólo oportunidades cuyo
   * `detectedAt` sea estrictamente posterior. Se usa como cursor para el
   * refresco automático del tablero.
   */
  since?: string;
  /**
   * Máximo de entradas devueltas en la respuesta (tope duro del backend: 100).
   */
  limit?: number;
}

/** Ruta relativa del endpoint de estado. */
const STATUS_PATH = '/api/status';
/** Ruta relativa del endpoint de oportunidades. */
const OPPORTUNITIES_PATH = '/api/opportunities';
/** Ruta relativa del endpoint de liveness. */

/**
 * Combina una URL base con una ruta relativa evitando dobles barras. Si
 * `baseUrl` está vacía se devuelve la ruta tal cual para consumirla contra el
 * mismo origen del HTML servido.
 */
export function joinUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return path;
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

/**
 * Ejecuta un GET JSON con manejo uniforme de errores. Se aparta como helper
 * privado para que `fetchBotStatus` y `fetchOpportunities` no dupliquen la
 * lógica de cabecera, `cache: 'no-store'` y comprobación de `response.ok`.
 */
async function getJson<T>(
  url: string,
  fetchImpl: typeof fetch,
  options: RequestOptions,
): Promise<T> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/**
 * Descarga el estado agregado del bot desde `GET /api/status`.
 * Cumple con el criterio de la Tarea 6.1 y sirve de fuente para el header
 * del dashboard, las métricas y los gráficos de tendencia (Tarea 6.3).
 */
export async function fetchBotStatus(
  baseUrl: string,
  options: RequestOptions = {},
  fetchImpl: typeof fetch = getGlobalFetch(),
): Promise<BotStatus> {
  return getJson<BotStatus>(joinUrl(baseUrl, STATUS_PATH), fetchImpl, options);
}

/**
 * Descarga las oportunidades detectadas desde `GET /api/opportunities`.
 * Soporta `since` (cursor ISO) y `limit` (máx. 100) para permitir pull
 * incremental cada tick del polling — así el tablero se actualiza
 * automáticamente cuando el backend registra una nueva detección.
 */
export async function fetchOpportunities(
  baseUrl: string,
  options: FetchOpportunitiesOptions = {},
  fetchImpl: typeof fetch = getGlobalFetch(),
): Promise<OpportunitiesResponse> {
  const query = buildOpportunitiesQuery(options);
  const url = `${joinUrl(baseUrl, OPPORTUNITIES_PATH)}${query}`;
  return getJson<OpportunitiesResponse>(url, fetchImpl, options);
}

/**
 * Comprueba la salud del backend (`GET /api/health`). Se expone en el cliente
 * para poder mostrar un indicador de conectividad sin acoplar `app.tsx` al
 * detalle del endpoint.
 */
export async function fetchHealth(
  baseUrl: string,
  options: RequestOptions = {},
  fetchImpl: typeof fetch = getGlobalFetch(),
): Promise<{ status: string; timestamp: string }> {
  return getJson(joinUrl(baseUrl, HEALTH_PATH), fetchImpl, options);
}

/**
 * Fábrica que enlaza una `baseUrl` y una implementación de `fetch` a un
 * conjunto de funciones prevalorizadas. Es lo que consume `app.tsx` para no
 * repetir la URL base en cada llamada.
 */
export interface BotApiClient {
  /** Devuelve el estado global del bot. */
  getStatus(options?: RequestOptions): Promise<BotStatus>;
  /** Devuelve las oportunidades detectadas (con soporte `since` + `limit`). */
  getOpportunities(options?: FetchOpportunitiesOptions): Promise<OpportunitiesResponse>;
  /** Devuelve el resultado del endpoint de liveness. */
  getHealth(options?: RequestOptions): Promise<{ status: string; timestamp: string }>;
}

/**
 * Construye un `BotApiClient` con la URL base y el `fetch` inyectados.
 * Preserva la referencia a `fetchImpl` para que los tests puedan sustituirlo
 * sin tener que reescribir la lógica de cada método.
 */
export function createBotApiClient(options: BotApiClientOptions = {}): BotApiClient {
  const baseUrl = options.baseUrl ?? '';
  const fetchImpl = options.fetchImpl ?? getGlobalFetch();
  return {
    getStatus: (opts = {}) => fetchBotStatus(baseUrl, opts, fetchImpl),
    getOpportunities: (opts = {}) => fetchOpportunities(baseUrl, opts, fetchImpl),
    getHealth: (opts = {}) => fetchHealth(baseUrl, opts, fetchImpl),
  };
}

/**
 * Serializa `since` + `limit` en un query string listo para concatenar.
 * Devuelve cadena vacía si no hay ningún parámetro presente, evitando
 * generar URLs con un `?` colgando.
 */
function buildOpportunitiesQuery(options: FetchOpportunitiesOptions): string {
  const params = new URLSearchParams();
  if (typeof options.since === 'string' && options.since.length > 0) {
    params.set('since', options.since);
  }
  if (typeof options.limit === 'number' && Number.isFinite(options.limit)) {
    params.set('limit', String(Math.max(1, Math.floor(options.limit))));
  }
  const serialized = params.toString();
  return serialized.length === 0 ? '' : `?${serialized}`;
}

/**
 * Recupera el `fetch` global del entorno. Lanza si no está disponible, lo
 * que revela un fallo de configuración temprano en lugar de manifestarse
 * como un error críptico en el primer polling.
 */
function getGlobalFetch(): typeof fetch {
  const g = globalThis as { fetch?: typeof fetch };
  if (typeof g.fetch !== 'function') {
    throw new Error('fetch global no disponible; inyecta fetchImpl al crear el cliente');
  }
  return g.fetch.bind(globalThis);
}

const HEALTH_PATH = '/api/health';
