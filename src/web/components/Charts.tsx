/**
 * Componente `Charts` (Tarea 6.3).
 *
 * Integra Chart.js para visualizar dos series con datos históricos del bot:
 *   1. Evolución temporal del beneficio neto acumulado (USDC) y del número
 *      total de oportunidades detectadas, en un mismo gráfico de líneas con
 *      dos ejes Y (izquierdo: USDC, derecho: oportunidades).
 *   2. Ganancias diarias agregadas por día calendario, en un gráfico de
 *      barras (verde = ganancia positiva, rojo = pérdida diaria).
 *
 * El componente es puro respecto al historial que recibe por prop: no toca
 * `localStorage` ni hace fetch adicional. Se apoya en el buffer circular ya
 * mantenido por `app.tsx` (máx. 50 snapshots) que se persiste entre sesiones.
 *
 * Runtime: Chart.js se importa desde `chart.js/auto`, que se resuelve en el
 * navegador contra el import map de `public/index.html` (esm.sh). No hay
 * bundler: `tsc --project tsconfig.web.json` sólo emite este archivo y sus
 * tipos ambient (`src/web/types/chart.d.ts`).
 */
import { useEffect, useMemo, useRef } from 'react';
import Chart from 'chart.js/auto';

/**
 * Punto normalizado del historial que consumen los gráficos. `app.tsx`
 * convierte los `HistorySnapshot` a esta forma antes de renderizar el
 * componente para no exponer aquí la interfaz completa `BotStatus`.
 */
export interface ChartsHistoryPoint {
  /** Marca temporal ISO-8601 del snapshot original. */
  capturedAt: string;
  /** Beneficio neto acumulado (USDC) ya convertido a número JS. */
  netProfitUsdc: number;
  /** Oportunidades detectadas acumuladas hasta el snapshot. */
  opportunitiesDetected: number;
  /** Bundles confirmados on-chain. */
  bundlesConfirmed: number;
  /** Bundles rechazados o expirados. */
  bundlesFailed: number;
}

/** Series agregadas por día calendario para el gráfico de barras. */
interface DailySeries {
  labels: string[];
  dailyProfits: number[];
  dailyOpportunities: number[];
}

/**
 * Panel principal de gráficos: renderiza dos canvases y mantiene sus
 * instancias de Chart.js sincronizadas con la prop `history` mediante
 * `chart.update('none')` (sin animación) para no interferir con el polling
 * de 2 s del dashboard.
 */
export function Charts(props: { history: ChartsHistoryPoint[] }): JSX.Element {
  const { history } = props;

  // Referencias a los canvases físicos que se pasan al constructor de Chart.
  const timelineCanvasRef = useRef<HTMLCanvasElement>(null);
  const dailyCanvasRef = useRef<HTMLCanvasElement>(null);

  // Referencias a las instancias de Chart para poder actualizarlas y
  // destruirlas sin recrear el DOM en cada render.
  const timelineChartRef = useRef<Chart | null>(null);
  const dailyChartRef = useRef<Chart | null>(null);

  // Serie temporal derivada: se recalcula sólo cuando cambia el historial.
  const timeline = useMemo(() => buildTimelineSeries(history), [history]);
  // Agregado diario derivado del mismo historial.
  const daily = useMemo<DailySeries>(() => buildDailySeries(history), [history]);

  // Efecto: crear (primera vez) o actualizar el gráfico de líneas.
  useEffect(() => {
    if (timelineCanvasRef.current === null) {
      return;
    }
    if (timelineChartRef.current === null) {
      timelineChartRef.current = new Chart(timelineCanvasRef.current, {
        type: 'line',
        data: {
          labels: timeline.labels,
          datasets: [
            {
              label: 'Beneficio neto (USDC)',
              data: timeline.netProfit,
              borderColor: '#22c55e',
              backgroundColor: 'rgba(34, 197, 94, 0.12)',
              fill: true,
              tension: 0.25,
              yAxisID: 'yProfit',
              borderWidth: 2,
            },
            {
              label: 'Oportunidades detectadas',
              data: timeline.opportunities,
              borderColor: '#38bdf8',
              backgroundColor: 'rgba(56, 189, 248, 0.10)',
              fill: false,
              tension: 0.25,
              yAxisID: 'yOpps',
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: '#e2e8f0' } },
            title: { display: true, text: 'Evolución temporal', color: '#e2e8f0' },
          },
          scales: {
            x: {
              ticks: { color: '#94a3b8' },
              grid: { color: 'rgba(148,163,184,0.10)' },
            },
            yProfit: {
              type: 'linear',
              position: 'left',
              ticks: { color: '#22c55e' },
              grid: { color: 'rgba(148,163,184,0.10)' },
              title: { display: true, text: 'USDC', color: '#22c55e' },
            },
            yOpps: {
              type: 'linear',
              position: 'right',
              ticks: { color: '#38bdf8' },
              grid: { display: false },
              title: { display: true, text: 'Oportunidades', color: '#38bdf8' },
            },
          },
          animation: false,
        },
      });
    } else {
      const chart = timelineChartRef.current;
      chart.data.labels = timeline.labels;
      chart.data.datasets[0].data = timeline.netProfit;
      chart.data.datasets[1].data = timeline.opportunities;
      chart.update('none');
    }
  }, [timeline]);

  // Efecto: crear (primera vez) o actualizar el gráfico de barras diarias.
  useEffect(() => {
    if (dailyCanvasRef.current === null) {
      return;
    }
    const barColors = daily.dailyProfits.map((v) =>
      v >= 0 ? 'rgba(34, 197, 94, 0.65)' : 'rgba(239, 68, 68, 0.65)',
    );
    const borderColors = daily.dailyProfits.map((v) => (v >= 0 ? '#22c55e' : '#ef4444'));

    if (dailyChartRef.current === null) {
      dailyChartRef.current = new Chart(dailyCanvasRef.current, {
        type: 'bar',
        data: {
          labels: daily.labels,
          datasets: [
            {
              label: 'Ganancia diaria (USDC)',
              data: daily.dailyProfits,
              backgroundColor: barColors,
              borderColor: borderColors,
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            title: { display: true, text: 'Ganancias diarias', color: '#e2e8f0' },
          },
          scales: {
            x: { ticks: { color: '#94a3b8' }, grid: { display: false } },
            y: {
              ticks: { color: '#94a3b8' },
              grid: { color: 'rgba(148,163,184,0.10)' },
              title: { display: true, text: 'USDC', color: '#94a3b8' },
            },
          },
          animation: false,
        },
      });
    } else {
      const chart = dailyChartRef.current;
      chart.data.labels = daily.labels;
      chart.data.datasets[0].data = daily.dailyProfits;
      chart.data.datasets[0].backgroundColor = barColors;
      chart.data.datasets[0].borderColor = borderColors;
      chart.update('none');
    }
  }, [daily]);

  // Efecto de limpieza: destruye ambas instancias al desmontar el componente
  // para evitar fugas de memoria y listeners colgantes de Chart.js.
  useEffect(() => {
    return () => {
      timelineChartRef.current?.destroy();
      timelineChartRef.current = null;
      dailyChartRef.current?.destroy();
      dailyChartRef.current = null;
    };
  }, []);

  // Placeholder discreto si aún no hay historial. Los canvases se montan
  // sólo cuando hay datos para no crear instancias vacías de Chart.js.
  if (history.length === 0) {
    return (
      <section className="panel">
        <h2>Métricas</h2>
        <p className="placeholder">
          Aún no hay historial suficiente para renderizar los gráficos. Los
          datos aparecerán en cuanto el bot registre cambios (los snapshots
          se acumulan en el historial persistente del navegador).
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Métricas</h2>
      <div className="charts-grid">
        <div className="chart-wrapper">
          <canvas
            ref={timelineCanvasRef}
            aria-label="Evolución temporal de beneficio neto y oportunidades detectadas"
            role="img"
          />
        </div>
        <div className="chart-wrapper">
          <canvas
            ref={dailyCanvasRef}
            aria-label="Ganancias diarias agregadas en USDC"
            role="img"
          />
        </div>
      </div>
    </section>
  );
}

/**
 * Construye la serie temporal directa (una entrada por snapshot). Cada
 * etiqueta se formatea como hora local `HH:MM:SS` para que sea legible sin
 * ocupar demasiado espacio horizontal en el eje X.
 */
function buildTimelineSeries(history: ChartsHistoryPoint[]): {
  labels: string[];
  netProfit: number[];
  opportunities: number[];
} {
  const labels: string[] = [];
  const netProfit: number[] = [];
  const opportunities: number[] = [];
  for (const entry of history) {
    labels.push(formatTimestampShort(entry.capturedAt));
    netProfit.push(entry.netProfitUsdc);
    opportunities.push(entry.opportunitiesDetected);
  }
  return { labels, netProfit, opportunities };
}

/**
 * Agrega el historial por día calendario (zona horaria del navegador) y
 * calcula la diferencia entre el último y el primer snapshot de cada día
 * para obtener la ganancia y las oportunidades detectadas del día.
 *
 * Nota: como los valores acumulados sólo pueden aumentar en operación
 * normal, la diferencia suele ser positiva. Si el bot se reinicia en medio
 * del día y las métricas se resetean, la diferencia puede ser negativa; en
 * ese caso el gráfico lo pinta en rojo para hacerlo visible.
 */
function buildDailySeries(history: ChartsHistoryPoint[]): DailySeries {
  if (history.length === 0) {
    return { labels: [], dailyProfits: [], dailyOpportunities: [] };
  }
  const buckets = new Map<string, { first: ChartsHistoryPoint; last: ChartsHistoryPoint }>();
  for (const entry of history) {
    const day = formatDayKey(entry.capturedAt);
    const existing = buckets.get(day);
    if (existing === undefined) {
      buckets.set(day, { first: entry, last: entry });
    } else {
      existing.last = entry;
    }
  }
  const labels = [...buckets.keys()].sort();
  const dailyProfits: number[] = [];
  const dailyOpportunities: number[] = [];
  for (const label of labels) {
    const bucket = buckets.get(label);
    if (bucket === undefined) {
      continue;
    }
    dailyProfits.push(round2(bucket.last.netProfitUsdc - bucket.first.netProfitUsdc));
    dailyOpportunities.push(
      Math.max(0, bucket.last.opportunitiesDetected - bucket.first.opportunitiesDetected),
    );
  }
  return { labels, dailyProfits, dailyOpportunities };
}

/** Redondea a 2 decimales para evitar ruido en el eje Y del gráfico diario. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Convierte un ISO-8601 a la clave de día calendario `YYYY-MM-DD` en la
 * zona horaria del navegador. Ante entradas inválidas devuelve el string
 * original para no romper el orden ni el `Map`.
 */
function formatDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Etiqueta compacta de hora local para el eje X del gráfico de líneas.
 * `toLocaleTimeString` sin opciones produce algo como `10:23:04` en la
 * mayoría de locales, lo que es suficiente para un dashboard técnico.
 */
function formatTimestampShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleTimeString();
}

