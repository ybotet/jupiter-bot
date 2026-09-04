/**
 * Declaración ambient mínima para `chart.js/auto` (Tarea 6.3).
 *
 * El proyecto no usa bundler: el runtime de Chart.js se resuelve en el
 * navegador desde el CDN esm.sh via import map declarado en
 * `public/index.html`. Para satisfacer el checker de TypeScript sin depender
 * de que `npm install chart.js` haya podido descargar los tipos oficiales
 * (el registro puede estar temporalmente inaccesible desde este entorno),
 * declaramos aquí una superficie de tipos deliberadamente pequeña que cubra
 * únicamente los pedazos de la API v4 que consumimos en `Charts.tsx`.
 *
 * Si en el futuro se instala el paquete oficial y sus tipos entran vía
 * `node_modules/@types` o del propio `chart.js`, esta declaración local se
 * puede eliminar sin cambios en el componente: la superficie usada aquí es
 * un subconjunto estricto de la superficie pública de Chart.js 4.x.
 */
declare module 'chart.js/auto' {
  /** Configuración de un dataset (subset de `ChartDataset<TType, TData>`). */
  export interface ChartDataset {
    label?: string;
    data: number[];
    borderColor?: string | string[];
    backgroundColor?: string | string[];
    fill?: boolean;
    tension?: number;
    yAxisID?: string;
    borderWidth?: number;
  }

  /** Bloque `data` de la configuración del gráfico. */
  export interface ChartData {
    labels: string[];
    datasets: ChartDataset[];
  }

  /** Opciones de escala genéricas (Chart.js las tipa por eje concreto). */
  export interface ChartScaleOptions {
    type?: 'linear' | 'category' | 'logarithmic' | 'time' | 'timeseries';
    position?: 'left' | 'right' | 'top' | 'bottom';
    ticks?: { color?: string };
    grid?: { color?: string; display?: boolean };
    title?: { display?: boolean; text?: string; color?: string };
  }

  /** Opciones globales del gráfico (subset). */
  export interface ChartOptions {
    responsive?: boolean;
    maintainAspectRatio?: boolean;
    interaction?: { mode?: 'index' | 'nearest' | 'point' | 'dataset'; intersect?: boolean };
    plugins?: {
      legend?: { display?: boolean; labels?: { color?: string } };
      tooltip?: { enabled?: boolean };
      title?: { display?: boolean; text?: string; color?: string };
    };
    scales?: Record<string, ChartScaleOptions>;
    animation?: false | { duration?: number };
  }

  /** Configuración completa que consume el constructor de `Chart`. */
  export interface ChartConfiguration {
    type: 'line' | 'bar';
    data: ChartData;
    options?: ChartOptions;
  }

  /**
   * Clase principal de Chart.js. La declaración local se limita a los
   * miembros que usa `Charts.tsx`: constructor, `data`, `update()` y
   * `destroy()`. El resto de la API queda fuera del contrato tipado.
   */
  export default class Chart {
    constructor(context: CanvasRenderingContext2D | HTMLCanvasElement, config: ChartConfiguration);
    data: ChartData;
    options: ChartOptions;
    update(mode?: 'none' | 'active' | 'reset' | 'resize' | 'show' | 'hide'): void;
    destroy(): void;
  }
}
