/**
 * Aplicación principal del dashboard web del bot Jupiter (Tarea 6.4).
 *
 * Este archivo concentra los cuatro bloques exigidos por los criterios de
 * aceptación del Módulo 6:
 *   - Tablero de oportunidades detectadas (Tarea 6.2, criterio "tiempo real").
 *   - Gráficos de series temporales (Tarea 6.3).
 *   - Historial de instantáneas de estado (persistido en `localStorage`).
 *   - Panel de configuración editable (persistido en `localStorage`).
 *
 * El refresco en tiempo real se obtiene con polling cada 2 segundos contra
 * los endpoints `GET /api/status` y `GET /api/opportunities` publicados por
 * el servidor Express (Tarea 6.1). Toda la capa de acceso HTTP vive en
 * `./api/client.ts` (Tarea 6.4); este archivo se limita a componer los
 * datos en pantalla. El tablero se actualiza automáticamente al detectar
 * una oportunidad porque cada tick del polling hace un pull incremental
 * con el parámetro `?since=<detectedAt-anterior>` y agrega los nuevos ítems
 * al buffer local sin duplicar entradas.
 */
import type { ChangeEvent, Dispatch, MutableRefObject, SetStateAction } from 'react';
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Charts, type ChartsHistoryPoint } from './components/Charts.js';
import { createBotApiClient, type BotStatus, type DetectedOpportunity } from './api/client.js';

/** Registro individual del historial local de instantáneas del bot. */
interface HistorySnapshot {
  /** Marca temporal ISO-8601 en la que se capturó la instantánea. */
  capturedAt: string;
  /** Estado agregado devuelto por la API en ese momento. */
  status: BotStatus;
}

/** Configuración del cliente persistida en `localStorage`. */
interface DashboardConfig {
  /** Intervalo de polling en milisegundos (mínimo 500 ms). */
  pollIntervalMs: number;
  /** URL base de la API. Vacío = mismo origen que el HTML. */
  apiBaseUrl: string;
  /** Umbral mínimo de beneficio para resaltar oportunidades en el tablero. */
  minProfitUsdc: number;
  /** Slippage máximo tolerado en puntos básicos (100 bps = 1%). */
  maxSlippageBps: number;
}

/** Máximo de instantáneas conservadas en el historial local. */
const MAX_HISTORY_ENTRIES = 50;

/** Máximo de oportunidades vivas conservadas en el buffer del tablero. */
const MAX_LIVE_OPPORTUNITIES = 100;

/** Clave de `localStorage` donde se persiste la configuración del panel. */
const CONFIG_STORAGE_KEY = 'jupiter-bot:dashboard-config';

/** Clave de `localStorage` donde se persiste el historial de snapshots. */
const HISTORY_STORAGE_KEY = 'jupiter-bot:dashboard-history';

/** Ruta del endpoint de estado usado por el dashboard. */
const STATUS_ENDPOINT = '/api/status';

/** Configuración por defecto usada cuando `localStorage` está vacío o corrupto. */
const DEFAULT_CONFIG: DashboardConfig = {
  pollIntervalMs: 2000,
  apiBaseUrl: '',
  minProfitUsdc: 0.1,
  maxSlippageBps: 50,
};

/**
 * Componente raíz. Orquesta el polling, mantiene el historial en memoria y
 * decide qué pestaña se muestra al usuario (tablero, historial o configuración).
 */
function App(): JSX.Element {
  // Estado persistente: configuración editable por el usuario.
  const [config, setConfig] = useState<DashboardConfig>(() => loadConfigFromStorage());
  // Estado transitorio: último snapshot recibido de la API.
  const [status, setStatus] = useState<BotStatus | null>(null);
  // Buffer vivo de oportunidades detectadas (Tarea 6.4). Se refresca con pull
  // incremental cada tick del polling y se ordena por `detectedAt` descendente.
  const [opportunities, setOpportunities] = useState<DetectedOpportunity[]>([]);
  // Mensaje de error humano (fetch fallido, respuesta no válida, etc.).
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Marca temporal ISO-8601 del último fetch exitoso.
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  // Historial persistente de snapshots recientes.
  const [history, setHistory] = useState<HistorySnapshot[]>(() => loadHistoryFromStorage());
  // Pestaña visible: 'dashboard' | 'metrics' | 'history' | 'config'.
  const [activeTab, setActiveTab] = useState<'dashboard' | 'metrics' | 'history' | 'config'>(
    'dashboard',
  );

  // Referencia estable a la última firma comparable para no duplicar entradas.
  const lastSignatureRef = useRef<string | null>(null);
  // Cursor incremental para el pull de `GET /api/opportunities?since=...`.
  // Contiene el `detectedAt` (ISO-8601) del ítem más reciente ya conocido.
  const lastOpportunityCursorRef = useRef<string | null>(null);

  // Cliente HTTP memoizado: sólo se recrea cuando cambia `apiBaseUrl`.
  const apiClient = useMemo(
    () => createBotApiClient({ baseUrl: config.apiBaseUrl }),
    [config.apiBaseUrl],
  );

  /**
   * Descarga el estado del bot y el delta de oportunidades desde la API,
   * actualizando el historial local. Se envuelve en `useCallback` para poder
   * pasarla como dependencia estable al `useEffect` de polling.
   */
  const fetchDashboardData = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        // Lanzamos ambas peticiones en paralelo: la latencia total es
        // aproximadamente la del endpoint más lento, no la suma.
        const [statusPayload, opportunitiesPayload] = await Promise.all([
          apiClient.getStatus({ signal }),
          apiClient.getOpportunities({
            signal,
            since: lastOpportunityCursorRef.current ?? undefined,
          }),
        ]);
        const now = new Date().toISOString();
        setStatus(statusPayload);
        setErrorMessage(null);
        setLastUpdatedAt(now);
        appendHistoryEntry(statusPayload, now, lastSignatureRef, setHistory);
        if (opportunitiesPayload.items.length > 0) {
          mergeOpportunities(
            opportunitiesPayload.items,
            lastOpportunityCursorRef,
            setOpportunities,
          );
        }
      } catch (err) {
        // Un `AbortError` no es un fallo del bot: es la señal esperada cuando
        // el componente se remonta o el intervalo se reinicia. Lo silenciamos.
        if (isAbortError(err)) return;
        // Nunca imprimimos el objeto de error crudo: podría contener detalles
        // del transporte HTTP (URL con credenciales, etc.). Extraemos sólo el
        // mensaje textual que ya sanea `Error.message`.
        setErrorMessage(
          err instanceof Error ? err.message : 'Error desconocido al consultar la API',
        );
      }
    },
    [apiClient],
  );

  // Efecto de polling: dispara `fetchDashboardData` al montar y cada `pollIntervalMs`.
  useEffect(() => {
    // Guardarraíl: nunca pollear más rápido que 500 ms para no saturar la API.
    const intervalMs = Math.max(500, config.pollIntervalMs);
    const controller = new AbortController();
    void fetchDashboardData(controller.signal);
    const handle = window.setInterval(() => {
      void fetchDashboardData(controller.signal);
    }, intervalMs);
    return () => {
      window.clearInterval(handle);
      controller.abort();
    };
  }, [fetchDashboardData, config.pollIntervalMs]);

  // Persiste la configuración cada vez que cambia.
  useEffect(() => {
    try {
      window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch {
      // Modo incógnito o cuota agotada: se ignora silenciosamente.
    }
  }, [config]);

  // Persiste el historial cada vez que cambia.
  useEffect(() => {
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch {
      // Idem: la persistencia del historial es best-effort.
    }
  }, [history]);

  /** Vacía el historial local (no afecta al servidor). */
  const handleClearHistory = useCallback((): void => {
    setHistory([]);
    lastSignatureRef.current = null;
  }, []);

  /** Restaura la configuración a los valores por defecto. */
  const handleResetConfig = useCallback((): void => {
    setConfig({ ...DEFAULT_CONFIG });
  }, []);

  return (
    <div className="app">
      <Header
        status={status}
        lastUpdatedAt={lastUpdatedAt}
        errorMessage={errorMessage}
        pollIntervalMs={config.pollIntervalMs}
      />
      <nav className="tabs" aria-label="Secciones del dashboard">
        <TabButton
          label="Tablero"
          active={activeTab === 'dashboard'}
          onClick={() => setActiveTab('dashboard')}
        />
        <TabButton
          label="Métricas"
          active={activeTab === 'metrics'}
          onClick={() => setActiveTab('metrics')}
        />
        <TabButton
          label="Historial"
          active={activeTab === 'history'}
          onClick={() => setActiveTab('history')}
        />
        <TabButton
          label="Configuración"
          active={activeTab === 'config'}
          onClick={() => setActiveTab('config')}
        />
      </nav>
      <main className="content">
        {activeTab === 'dashboard' && (
          <OpportunitiesDashboard
            status={status}
            opportunities={opportunities}
            config={config}
            errorMessage={errorMessage}
          />
        )}
        {activeTab === 'metrics' && <Charts history={mapHistoryToChartPoints(history)} />}
        {activeTab === 'history' && (
          <TransactionHistory history={history} onClear={handleClearHistory} />
        )}
        {activeTab === 'config' && (
          <ConfigurationPanel config={config} onChange={setConfig} onReset={handleResetConfig} />
        )}
      </main>
      <footer className="footer">
        <span>Jupiter Bot Dashboard · Tarea 6.3</span>
      </footer>
    </div>
  );
}

/**
 * Cabecera con el resumen operativo: estado, cluster, versión y último refresco.
 * Muestra también un banner de error si el último fetch falló.
 */
function Header(props: {
  status: BotStatus | null;
  lastUpdatedAt: string | null;
  errorMessage: string | null;
  pollIntervalMs: number;
}): JSX.Element {
  const { status, lastUpdatedAt, errorMessage, pollIntervalMs } = props;
  return (
    <header className="header">
      <div className="header-title">
        <h1>Jupiter Bot</h1>
        <span className={`status-pill status-${status?.state ?? 'unknown'}`}>
          {status?.state ?? 'sin datos'}
        </span>
      </div>
      <dl className="header-meta">
        <div>
          <dt>Cluster</dt>
          <dd>{status?.cluster ?? '—'}</dd>
        </div>
        <div>
          <dt>Versión</dt>
          <dd>{status?.version ?? '—'}</dd>
        </div>
        <div>
          <dt>Último refresco</dt>
          <dd>{formatTimestamp(lastUpdatedAt)}</dd>
        </div>
        <div>
          <dt>Intervalo</dt>
          <dd>{pollIntervalMs} ms</dd>
        </div>
      </dl>
      {errorMessage !== null && (
        <div className="error-banner" role="alert">
          Error al consultar el estado del bot: {errorMessage}
        </div>
      )}
    </header>
  );
}

/** Botón individual de la barra de pestañas superior. */
function TabButton(props: { label: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className={props.active ? 'tab tab-active' : 'tab'}
      onClick={props.onClick}
      aria-pressed={props.active}
    >
      {props.label}
    </button>
  );
}

/**
 * Tablero de oportunidades en tiempo real. Muestra las métricas actuales y
 * un aviso destacado cuando el beneficio neto acumulado supera el umbral
 * configurado en el panel de configuración.
 */
function OpportunitiesDashboard(props: {
  status: BotStatus | null;
  opportunities: DetectedOpportunity[];
  config: DashboardConfig;
  errorMessage: string | null;
}): JSX.Element {
  const { status, opportunities, config, errorMessage } = props;

  // Si aún no hay datos y no hay error explícito, mostramos un placeholder
  // discreto para que el usuario sepa que el polling está en marcha.
  if (status === null) {
    return (
      <section className="panel">
        <h2>Tablero de oportunidades</h2>
        <p className="placeholder">
          {errorMessage === null
            ? 'Esperando primer refresco del estado del bot…'
            : 'Sin datos disponibles todavía.'}
        </p>
      </section>
    );
  }

  const netProfitValue = parseNumericProfit(status.metrics.netProfitUsdc);
  const isProfitable = netProfitValue >= config.minProfitUsdc;

  return (
    <section className="panel">
      <h2>Tablero de oportunidades</h2>
      <div className="metrics-grid">
        <MetricCard label="Detectadas" value={status.metrics.opportunitiesDetected} />
        <MetricCard label="Bundles enviados" value={status.metrics.bundlesSubmitted} />
        <MetricCard label="Bundles confirmados" value={status.metrics.bundlesConfirmed} />
        <MetricCard label="Bundles fallidos" value={status.metrics.bundlesFailed} />
      </div>
      <div className={isProfitable ? 'profit-card profit-positive' : 'profit-card profit-neutral'}>
        <h3>Beneficio neto acumulado</h3>
        <p className="profit-value">{status.metrics.netProfitUsdc} USDC</p>
        <p className="profit-hint">
          {isProfitable
            ? `Supera el umbral configurado (${config.minProfitUsdc} USDC).`
            : `Umbral configurado: ${config.minProfitUsdc} USDC.`}
        </p>
      </div>
      <dl className="secondary-meta">
        <div>
          <dt>Arranque</dt>
          <dd>{formatTimestamp(status.startedAt ?? null)}</dd>
        </div>
        <div>
          <dt>Último heartbeat</dt>
          <dd>{formatTimestamp(status.lastHeartbeatAt ?? null)}</dd>
        </div>
      </dl>
      <OpportunityList opportunities={opportunities} maxSlippageBps={config.maxSlippageBps} />
    </section>
  );
}

/** Renderiza las oportunidades recibidas desde el feed incremental de la API. */
function OpportunityList(props: {
  opportunities: DetectedOpportunity[];
  maxSlippageBps: number;
}): JSX.Element {
  const visibleOpportunities = props.opportunities.filter(
    (opportunity) => opportunity.slippageBps <= props.maxSlippageBps,
  );

  return (
    <div className="opportunities-list">
      <h3>Oportunidades recientes</h3>
      {visibleOpportunities.length === 0 ? (
        <p className="placeholder">No hay oportunidades dentro del límite de slippage.</p>
      ) : (
        <table className="history-table">
          <thead>
            <tr>
              <th>Ruta</th>
              <th>Beneficio neto (USDC)</th>
              <th>Slippage</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {visibleOpportunities.map((opportunity) => (
              <tr key={opportunity.id}>
                <td>{opportunity.route}</td>
                <td>{opportunity.netProfitUsdc}</td>
                <td>{opportunity.slippageBps} bps</td>
                <td>{opportunity.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Tarjeta compacta para mostrar una métrica numérica del tablero. */
function MetricCard(props: { label: string; value: number }): JSX.Element {
  return (
    <div className="metric-card">
      <span className="metric-label">{props.label}</span>
      <span className="metric-value">{props.value.toLocaleString('es-ES')}</span>
    </div>
  );
}

/**
 * Historial de instantáneas: renderiza en orden inverso (más reciente arriba)
 * los snapshots que han cambiado respecto al anterior. Permite vaciar el buffer.
 */
function TransactionHistory(props: {
  history: HistorySnapshot[];
  onClear: () => void;
}): JSX.Element {
  const { history, onClear } = props;
  const orderedHistory = useMemo(() => [...history].reverse(), [history]);

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Historial de estados</h2>
        <button
          type="button"
          className="secondary-button"
          onClick={onClear}
          disabled={history.length === 0}
        >
          Vaciar historial
        </button>
      </div>
      {orderedHistory.length === 0 ? (
        <p className="placeholder">Aún no hay cambios registrados en esta sesión.</p>
      ) : (
        <table className="history-table">
          <thead>
            <tr>
              <th>Instante</th>
              <th>Estado</th>
              <th>Detectadas</th>
              <th>Confirmados</th>
              <th>Fallidos</th>
              <th>Beneficio (USDC)</th>
            </tr>
          </thead>
          <tbody>
            {orderedHistory.map((entry) => (
              <tr key={entry.capturedAt}>
                <td>{formatTimestamp(entry.capturedAt)}</td>
                <td>
                  <span className={`status-pill status-${entry.status.state}`}>
                    {entry.status.state}
                  </span>
                </td>
                <td>{entry.status.metrics.opportunitiesDetected}</td>
                <td>{entry.status.metrics.bundlesConfirmed}</td>
                <td>{entry.status.metrics.bundlesFailed}</td>
                <td>{entry.status.metrics.netProfitUsdc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * Panel de configuración editable. Los ajustes son locales al navegador
 * (persistidos en `localStorage`) y sólo afectan al comportamiento del cliente:
 * intervalo de polling, URL de la API, umbral de beneficio y slippage máximo.
 * La persistencia server-side se difiere a la Tarea 6.4.
 */
function ConfigurationPanel(props: {
  config: DashboardConfig;
  onChange: (next: DashboardConfig) => void;
  onReset: () => void;
}): JSX.Element {
  const { config, onChange, onReset } = props;

  /**
   * Genera un handler de cambio para un campo numérico del formulario.
   * Ignora entradas no numéricas para evitar propagar `NaN` al estado global.
   */
  const handleNumericChange =
    (field: keyof DashboardConfig, min: number) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const raw = event.target.value;
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed)) {
        return;
      }
      onChange({ ...config, [field]: Math.max(min, parsed) });
    };

  /** Handler específico para el campo de texto `apiBaseUrl`. */
  const handleApiBaseUrlChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...config, apiBaseUrl: event.target.value.trim() });
  };

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Configuración</h2>
        <button type="button" className="secondary-button" onClick={onReset}>
          Restaurar valores por defecto
        </button>
      </div>
      <form className="config-form" onSubmit={(event) => event.preventDefault()}>
        <label className="config-field">
          <span>Intervalo de polling (ms)</span>
          <input
            type="number"
            min={500}
            step={100}
            value={config.pollIntervalMs}
            onChange={handleNumericChange('pollIntervalMs', 500)}
          />
        </label>
        <label className="config-field">
          <span>URL base de la API</span>
          <input
            type="url"
            placeholder="Vacío = mismo origen"
            value={config.apiBaseUrl}
            onChange={handleApiBaseUrlChange}
          />
        </label>
        <label className="config-field">
          <span>Beneficio mínimo (USDC)</span>
          <input
            type="number"
            min={0}
            step={0.01}
            value={config.minProfitUsdc}
            onChange={handleNumericChange('minProfitUsdc', 0)}
          />
        </label>
        <label className="config-field">
          <span>Slippage máximo (bps)</span>
          <input
            type="number"
            min={0}
            max={10000}
            step={1}
            value={config.maxSlippageBps}
            onChange={handleNumericChange('maxSlippageBps', 0)}
          />
        </label>
      </form>
      <p className="config-hint">
        Nota: estos ajustes viven en tu navegador. Los cambios de estrategia aplicables al bot se
        propagarán al servidor en una tarea posterior.
      </p>
    </section>
  );
}

/**
 * Convierte el historial persistido (`HistorySnapshot[]`) a la forma más
 * ligera que consume `<Charts />` (Tarea 6.3). El componente de gráficos no
 * necesita la interfaz completa `BotStatus`; sólo los cinco campos que
 * alimentan las series temporales.
 */
function mapHistoryToChartPoints(history: HistorySnapshot[]): ChartsHistoryPoint[] {
  return history.map((entry) => ({
    capturedAt: entry.capturedAt,
    netProfitUsdc: parseNumericProfit(entry.status.metrics.netProfitUsdc),
    opportunitiesDetected: entry.status.metrics.opportunitiesDetected,
    bundlesConfirmed: entry.status.metrics.bundlesConfirmed,
    bundlesFailed: entry.status.metrics.bundlesFailed,
  }));
}

/**
 * Añade una nueva entrada al historial local sólo si cambia respecto al último
 * snapshot recibido (comparación por firma serializada). Mantiene el buffer
 * acotado a `MAX_HISTORY_ENTRIES` para evitar crecimiento ilimitado.
 */
function appendHistoryEntry(
  status: BotStatus,
  capturedAt: string,
  lastSignatureRef: MutableRefObject<string | null>,
  setHistory: Dispatch<SetStateAction<HistorySnapshot[]>>,
): void {
  const signature = computeStatusSignature(status);
  if (lastSignatureRef.current === signature) {
    return;
  }
  lastSignatureRef.current = signature;
  setHistory((previous) => {
    const next = [...previous, { capturedAt, status }];
    if (next.length > MAX_HISTORY_ENTRIES) {
      return next.slice(next.length - MAX_HISTORY_ENTRIES);
    }
    return next;
  });
}

/** Fusiona oportunidades nuevas, elimina duplicados y actualiza el cursor temporal. */
function mergeOpportunities(
  incoming: DetectedOpportunity[],
  cursorRef: MutableRefObject<string | null>,
  setOpportunities: Dispatch<SetStateAction<DetectedOpportunity[]>>,
): void {
  setOpportunities((previous) => {
    const byId = new Map(previous.map((opportunity) => [opportunity.id, opportunity]));
    for (const opportunity of incoming) {
      byId.set(opportunity.id, opportunity);
    }
    return [...byId.values()]
      .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt))
      .slice(0, MAX_LIVE_OPPORTUNITIES);
  });

  const newest = incoming.reduce<DetectedOpportunity | null>((current, opportunity) => {
    if (current === null || Date.parse(opportunity.detectedAt) > Date.parse(current.detectedAt)) {
      return opportunity;
    }
    return current;
  }, null);
  if (newest !== null) {
    cursorRef.current = newest.detectedAt;
  }
}

/** Identifica la cancelación esperada de una petición al desmontar el componente. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Calcula una firma estable del snapshot para detectar cambios reales. Se
 * ignoran los campos temporales `startedAt` y `lastHeartbeatAt` porque
 * cambian en cada tick aunque el estado operativo sea idéntico.
 */
function computeStatusSignature(status: BotStatus): string {
  return JSON.stringify({
    state: status.state,
    cluster: status.cluster,
    version: status.version,
    metrics: status.metrics,
  });
}

/** Construye la URL absoluta o relativa del endpoint de estado. */
function buildStatusUrl(apiBaseUrl: string): string {
  if (apiBaseUrl.length === 0) {
    return STATUS_ENDPOINT;
  }
  const normalized = apiBaseUrl.replace(/\/+$/, '');
  return `${normalized}${STATUS_ENDPOINT}`;
}

/**
 * Formatea un timestamp ISO-8601 al idioma del navegador. Devuelve un guion
 * cuando la entrada es `null` o inválida para no romper el layout.
 */
function formatTimestamp(iso: string | null): string {
  if (iso === null) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

/**
 * Convierte la cadena decimal de `netProfitUsdc` en un número JavaScript
 * seguro para comparaciones locales. Nunca se usa para operaciones críticas
 * (esas viven en `Decimal.js` del lado backend); es sólo para colorear la UI.
 */
function parseNumericProfit(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Carga la configuración desde `localStorage` aplicando validaciones sobre
 * los tipos. Ante cualquier inconsistencia se cae al `DEFAULT_CONFIG`.
 */
function loadConfigFromStorage(): DashboardConfig {
  try {
    const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw === null) {
      return { ...DEFAULT_CONFIG };
    }
    const parsed = JSON.parse(raw) as Partial<DashboardConfig>;
    return {
      pollIntervalMs:
        typeof parsed.pollIntervalMs === 'number' && parsed.pollIntervalMs >= 500
          ? parsed.pollIntervalMs
          : DEFAULT_CONFIG.pollIntervalMs,
      apiBaseUrl:
        typeof parsed.apiBaseUrl === 'string' ? parsed.apiBaseUrl : DEFAULT_CONFIG.apiBaseUrl,
      minProfitUsdc:
        typeof parsed.minProfitUsdc === 'number' && parsed.minProfitUsdc >= 0
          ? parsed.minProfitUsdc
          : DEFAULT_CONFIG.minProfitUsdc,
      maxSlippageBps:
        typeof parsed.maxSlippageBps === 'number' && parsed.maxSlippageBps >= 0
          ? parsed.maxSlippageBps
          : DEFAULT_CONFIG.maxSlippageBps,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Carga el historial persistido. Si el formato es inconsistente devuelve un
 * array vacío en lugar de romper el arranque del dashboard.
 */
function loadHistoryFromStorage(): HistorySnapshot[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry): entry is HistorySnapshot => {
        if (typeof entry !== 'object' || entry === null) {
          return false;
        }
        const candidate = entry as Partial<HistorySnapshot>;
        return typeof candidate.capturedAt === 'string' && typeof candidate.status === 'object';
      })
      .slice(-MAX_HISTORY_ENTRIES);
  } catch {
    return [];
  }
}

/**
 * Punto de montaje del árbol React. Se ejecuta al cargar el bundle en el
 * navegador. Si el contenedor `#root` no existe se lanza un error visible en
 * consola para facilitar la depuración durante el desarrollo.
 */
function bootstrap(): void {
  const container = document.getElementById('root');
  if (container === null) {
    throw new Error('No se encontró el contenedor #root en el HTML');
  }
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

bootstrap();
