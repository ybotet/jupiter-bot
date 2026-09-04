import {
  createSilentLogger,
  serializeError,
  type Logger,
} from './logger';
import {
  defaultSecretsProvider,
  redactSensitiveFields,
  type SecretsProvider,
} from './secrets';

/**
 * Niveles de severidad admitidos por el sistema de alertas. Se ordenan de menor
 * a mayor gravedad para poder aplicar un umbral mínimo (`minLevel`).
 */
export const ALERT_LEVELS = ['info', 'warn', 'error', 'critical'] as const;

/** Alias tipado de los niveles admitidos. */
export type AlertLevel = (typeof ALERT_LEVELS)[number];

/**
 * Nombres de evento reservados que emiten los módulos internos. Se admite
 * cualquier cadena adicional para dejar la lista abierta a futuros consumidores.
 */
export type AlertEvent =
  | 'opportunity_lost'
  | 'transaction_failed'
  | 'transaction_succeeded'
  | 'rpc_error'
  | 'critical'
  | (string & { readonly __alert_event__?: never });

/**
 * Estructura del mensaje que se propaga a cada canal registrado. Todos los
 * campos que puedan contener datos sensibles se sanean con
 * `redactSensitiveFields` antes de serializar al transporte final.
 */
export interface AlertPayload {
  /** Nombre lógico del evento (permite filtrar/consultar en el dashboard). */
  event: AlertEvent;
  /** Severidad del mensaje; se compara contra el umbral configurado en el manager. */
  level: AlertLevel;
  /** Título corto que se muestra al inicio del mensaje. */
  title: string;
  /** Cuerpo descriptivo del evento. */
  message: string;
  /** Identificador de transacción cuando aplique (uuid propagado por el logger). */
  transactionId?: string;
  /** Datos auxiliares (bundleId, motivo, latencia, etc.). Serán saneados. */
  metadata?: Record<string, unknown>;
  /** ISO-8601 opcional; si falta se aplica `new Date().toISOString()` al enviar. */
  timestamp?: string;
}

/**
 * Contrato mínimo que debe implementar cualquier destino de alerta (Telegram,
 * Slack, PagerDuty, SMTP, etc.). Se mantiene deliberadamente pequeño para
 * poder inyectar dobles de prueba en las suites unitarias.
 */
export interface AlertChannel {
  /** Nombre humano legible del canal, usado en logs de auditoría. */
  readonly name: string;
  /** Entrega la alerta al destino final. Debe rechazar si el envío falla. */
  send(payload: AlertPayload): Promise<void>;
}

/** Firma mínima admitida para inyectar una implementación alternativa de `fetch`. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
}>;

/** Opciones aceptadas por `TelegramAlertChannel`. */
export interface TelegramAlertChannelOptions {
  botToken: string;
  chatId: string;
  /** Base URL alternativa (útil en pruebas). Por defecto la API pública de Telegram. */
  apiBaseUrl?: string;
  /** Implementación de fetch inyectable (por defecto el `fetch` global de Node 18+). */
  fetchImpl?: FetchLike;
  /** Timeout máximo por envío en milisegundos (por defecto 5s). */
  timeoutMs?: number;
}

/** Opciones aceptadas por `SlackAlertChannel`. */
export interface SlackAlertChannelOptions {
  webhookUrl: string;
  /** Implementación de fetch inyectable. */
  fetchImpl?: FetchLike;
  /** Timeout máximo por envío en milisegundos (por defecto 5s). */
  timeoutMs?: number;
}

/** Opciones aceptadas por `AlertManager`. */
export interface AlertManagerOptions {
  /** Colección de canales suscritos. Puede estar vacía. */
  channels?: AlertChannel[];
  /** Logger opcional para trazabilidad (por defecto silencioso). */
  logger?: Logger;
  /** Umbral mínimo por debajo del cual las alertas se descartan. */
  minLevel?: AlertLevel;
}

/** URL base pública del bot API de Telegram. */
export const TELEGRAM_DEFAULT_BASE_URL = 'https://api.telegram.org';

/** Timeout por defecto para los envíos HTTP a canales de alerta. */
export const DEFAULT_ALERT_TIMEOUT_MS = 5_000;

/** Nivel por defecto aplicado si no se configura `ALERT_MIN_LEVEL`. */
export const DEFAULT_ALERT_MIN_LEVEL: AlertLevel = 'warn';

/** Mapa de severidad a un entero comparable para el filtrado por umbral. */
const LEVEL_WEIGHT: Record<AlertLevel, number> = {
  info: 10,
  warn: 20,
  error: 30,
  critical: 40,
};

/**
 * Coordina el envío de alertas a todos los canales registrados. Ignora los
 * canales que fallen para que un incidente en un transporte no impida que
 * los demás reciban la notificación.
 */
export class AlertManager {
  private readonly channels: AlertChannel[];
  private readonly logger: Logger;
  private readonly minLevel: AlertLevel;

  /** Configura el manager con canales, logger y umbral mínimo de severidad. */
  constructor(options: AlertManagerOptions = {}) {
    this.channels = options.channels ?? [];
    this.logger = options.logger ?? createSilentLogger();
    this.minLevel = options.minLevel ?? DEFAULT_ALERT_MIN_LEVEL;
  }

  /** Devuelve los canales configurados (útil en pruebas y para auditoría). */
  public getChannels(): readonly AlertChannel[] {
    return this.channels;
  }

  /**
   * Envía la alerta a todos los canales que superen el umbral configurado.
   * Usa `Promise.allSettled` para no propagar el error si un canal falla y
   * registra el fallo con el logger inyectado sin exponer secretos.
   */
  public async notify(payload: AlertPayload): Promise<void> {
    if (!this.isAboveThreshold(payload.level)) {
      this.logger.debug(
        { event: payload.event, level: payload.level, minLevel: this.minLevel },
        'alert:below-threshold',
      );
      return;
    }

    if (this.channels.length === 0) {
      this.logger.debug({ event: payload.event }, 'alert:no-channels');
      return;
    }

    const enriched = this.enrichPayload(payload);

    const results = await Promise.allSettled(
      this.channels.map((channel) => channel.send(enriched)),
    );

    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      const channel = this.channels[i];
      if (result.status === 'fulfilled') {
        this.logger.info(
          { channel: channel.name, event: enriched.event, level: enriched.level },
          'alert:sent',
        );
        continue;
      }
      this.logger.warn(
        {
          channel: channel.name,
          event: enriched.event,
          err: serializeError(result.reason),
        },
        'alert:channel-failed',
      );
    }
  }

  /** Combina el timestamp por defecto y sanea la metadata antes de reenviar. */
  private enrichPayload(payload: AlertPayload): AlertPayload {
    return {
      ...payload,
      timestamp: payload.timestamp ?? new Date().toISOString(),
      metadata: payload.metadata ? redactSensitiveFields(payload.metadata) : undefined,
    };
  }

  /** Determina si el nivel recibido supera el umbral configurado. */
  private isAboveThreshold(level: AlertLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.minLevel];
  }
}

/**
 * Canal de alertas para Telegram. Usa la Bot API oficial y **nunca** registra
 * el token de bot ni la URL completa que lo contiene.
 */
export class TelegramAlertChannel implements AlertChannel {
  public readonly name = 'telegram';
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  /** Valida la configuración mínima y resuelve dependencias por defecto. */
  constructor(options: TelegramAlertChannelOptions) {
    if (!options.botToken || options.botToken.trim().length === 0) {
      throw new Error('TelegramAlertChannel requiere botToken');
    }
    if (!options.chatId || options.chatId.trim().length === 0) {
      throw new Error('TelegramAlertChannel requiere chatId');
    }
    this.botToken = options.botToken.trim();
    this.chatId = options.chatId.trim();
    this.apiBaseUrl = (options.apiBaseUrl ?? TELEGRAM_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? resolveGlobalFetch();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ALERT_TIMEOUT_MS;
  }

  /**
   * Publica el mensaje en el chat configurado. Si Telegram responde con un
   * status distinto de 2xx, se lanza un error saneado sin exponer el token.
   */
  public async send(payload: AlertPayload): Promise<void> {
    const url = `${this.apiBaseUrl}/bot${this.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: this.chatId,
      text: formatPlainMessage(payload),
      disable_web_page_preview: true,
    });

    const response = await runWithTimeout(
      this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
      this.timeoutMs,
      'telegram',
    );

    if (!response.ok) {
      // Se descarta el cuerpo detallado del error para no arriesgarse a filtrar
      // el token ni el chat_id en caso de que Telegram los devuelva reflejados.
      throw new Error(
        `Telegram sendMessage falló con status ${response.status} (${response.statusText})`,
      );
    }
  }
}

/**
 * Canal de alertas para Slack basado en Incoming Webhooks. La URL del webhook
 * contiene el secreto de autenticación, por lo que nunca se registra ni se
 * incluye en los mensajes de error.
 */
export class SlackAlertChannel implements AlertChannel {
  public readonly name = 'slack';
  private readonly webhookUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  /** Valida la URL del webhook y resuelve dependencias por defecto. */
  constructor(options: SlackAlertChannelOptions) {
    if (!options.webhookUrl || options.webhookUrl.trim().length === 0) {
      throw new Error('SlackAlertChannel requiere webhookUrl');
    }
    this.webhookUrl = options.webhookUrl.trim();
    this.fetchImpl = options.fetchImpl ?? resolveGlobalFetch();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ALERT_TIMEOUT_MS;
  }

  /**
   * Envía el payload al webhook de Slack. Si Slack responde con un status
   * distinto de 2xx, se lanza un error saneado sin exponer la URL secreta.
   */
  public async send(payload: AlertPayload): Promise<void> {
    const body = JSON.stringify({ text: formatPlainMessage(payload) });

    const response = await runWithTimeout(
      this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
      this.timeoutMs,
      'slack',
    );

    if (!response.ok) {
      throw new Error(
        `Slack webhook falló con status ${response.status} (${response.statusText})`,
      );
    }
  }
}

/**
 * Construye un `AlertManager` leyendo la configuración desde el
 * `SecretsProvider` (por defecto `.env`). Solo instancia el canal cuya
 * configuración esté completa; el resto se ignora silenciosamente.
 */
export function createAlertManagerFromEnv(
  provider: SecretsProvider = defaultSecretsProvider,
  options: Omit<AlertManagerOptions, 'channels'> & {
    fetchImpl?: FetchLike;
  } = {},
): AlertManager {
  const channels: AlertChannel[] = [];

  const telegramToken = provider.getSecret('TELEGRAM_BOT_TOKEN');
  const telegramChatId = provider.getSecret('TELEGRAM_CHAT_ID');
  if (telegramToken && telegramChatId) {
    channels.push(
      new TelegramAlertChannel({
        botToken: telegramToken,
        chatId: telegramChatId,
        fetchImpl: options.fetchImpl,
      }),
    );
  }

  const slackWebhook = provider.getSecret('SLACK_WEBHOOK_URL');
  if (slackWebhook) {
    channels.push(
      new SlackAlertChannel({
        webhookUrl: slackWebhook,
        fetchImpl: options.fetchImpl,
      }),
    );
  }

  const minLevel = parseAlertLevel(provider.getSecret('ALERT_MIN_LEVEL')) ?? options.minLevel;

  return new AlertManager({
    channels,
    logger: options.logger,
    minLevel,
  });
}

/**
 * Formatea el payload como un bloque de texto plano compatible tanto con
 * Telegram como con Slack. Se prioriza legibilidad y ausencia de markdown
 * específico para evitar problemas de escapado entre proveedores.
 */
function formatPlainMessage(payload: AlertPayload): string {
  const lines: string[] = [];
  lines.push(`[${payload.level.toUpperCase()}] ${payload.title}`);
  lines.push(payload.message);
  if (payload.transactionId) {
    lines.push(`transactionId: ${payload.transactionId}`);
  }
  if (payload.event) {
    lines.push(`event: ${payload.event}`);
  }
  if (payload.metadata && Object.keys(payload.metadata).length > 0) {
    for (const [key, value] of Object.entries(payload.metadata)) {
      lines.push(`${key}: ${stringifyMetadataValue(value)}`);
    }
  }
  if (payload.timestamp) {
    lines.push(`timestamp: ${payload.timestamp}`);
  }
  return lines.join('\n');
}

/** Serializa un valor de metadata para su uso en el cuerpo de la alerta. */
function stringifyMetadataValue(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/** Ejecuta una promesa con un timeout y aborta el fetch si expira. */
async function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  channelName: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  let handle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => {
      reject(new Error(`${channelName} alert send timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (handle) {
      clearTimeout(handle);
    }
  }
}

/**
 * Resuelve la implementación de `fetch` a partir del contexto global. Se
 * asume Node 18+ (el proyecto usa Node 22 en desarrollo), donde `fetch` es
 * global. Si no está disponible se lanza para que el consumidor inyecte una
 * implementación explícita.
 */
function resolveGlobalFetch(): FetchLike {
  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
  if (!globalFetch) {
    throw new Error(
      'fetch global no está disponible; inyecte fetchImpl al canal de alertas',
    );
  }
  return globalFetch;
}

/**
 * Valida y normaliza un nivel de alerta recibido como cadena. Devuelve
 * `undefined` si el valor no coincide con ninguno de los niveles admitidos.
 */
function parseAlertLevel(value: string | undefined): AlertLevel | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return (ALERT_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as AlertLevel)
    : undefined;
}

