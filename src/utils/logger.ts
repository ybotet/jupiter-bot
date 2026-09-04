import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { DestinationStream, LoggerOptions as PinoOptions, Logger as PinoLogger } from 'pino';
import pino from 'pino';

import {
  defaultSecretsProvider,
  redactSensitiveFields,
  REDACTED_PLACEHOLDER,
  SENSITIVE_FIELD_KEYWORDS,
  SecretsProvider,
} from './secrets';

/** Niveles admitidos por `pino` que aceptamos como configuración de logger. */
export const VALID_LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

/** Alias tipado de los niveles admitidos por el logger. */
export type LogLevel = (typeof VALID_LOG_LEVELS)[number];

/** Nombre por defecto del servicio incluido en cada línea de log. */
export const DEFAULT_SERVICE_NAME = 'jupiter-bot';

/** Ruta por defecto para el archivo rotativo cuando `LOG_FILE_PATH` no está definido. */
export const DEFAULT_LOG_FILE_PATH = 'logs/bot.log';

/** Frecuencia por defecto para la rotación de archivos (compatible con `pino-roll`). */
export const DEFAULT_ROTATION_FREQUENCY = 'daily';

/** Tamaño máximo por defecto de cada archivo rotado antes de dar paso al siguiente. */
export const DEFAULT_ROTATION_SIZE = '10m';

/** Número máximo por defecto de archivos históricos conservados por `pino-roll`. */
export const DEFAULT_ROTATION_LIMIT = 7;

/**
 * Configuración de la rotación diaria/por tamaño que se transfiere a `pino-roll`.
 * Todas las claves siguen la convención del transporte oficial.
 */
export interface LogRotationConfig {
  /** Frecuencia de rotación: `'daily' | 'hourly'` o milisegundos numéricos. */
  frequency: string | number;
  /** Tamaño máximo por archivo (por ejemplo `'10m'`). */
  size: string | number;
  /** Cuántos archivos históricos conservar como máximo. */
  limit: number;
}

/**
 * Opciones aceptadas por la fábrica `createLogger`. Todas son opcionales y
 * respetan la convención de inyección de dependencias del resto del proyecto.
 */
export interface LoggerFactoryOptions {
  /** Nombre lógico del servicio incluido como campo base en cada log. */
  service?: string;
  /** Nivel mínimo de log; sobreescribe el resuelto vía entorno. */
  level?: LogLevel;
  /** Ruta absoluta o relativa al archivo rotativo. */
  filePath?: string;
  /** Configuración de rotación (frecuencia, tamaño, retención). */
  rotation?: Partial<LogRotationConfig>;
  /**
   * Destino inyectado (útil en pruebas). Si se proporciona, se ignora la ruta
   * de archivo y no se arranca el transporte de `pino-roll`.
   */
  destination?: DestinationStream;
  /** Provider de secretos usado para leer variables de entorno (por defecto `.env`). */
  secretsProvider?: SecretsProvider;
  /** Campos base adicionales para adjuntar a cada línea de log. */
  baseFields?: Record<string, unknown>;
  /** Deshabilita la creación automática del directorio destino cuando es `false`. */
  createDirectory?: boolean;
}

/** Firma de logger expuesta al resto del proyecto (alias de `pino.Logger`). */
export type Logger = PinoLogger;

/**
 * Crea un logger que descarta cualquier entrada. Se usa como valor por defecto
 * cuando un módulo acepta un logger opcional para preservar su firma pública
 * sin obligar al consumidor a construir una instancia real.
 */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}

/**
 * Lee y valida las variables de entorno relacionadas con logging usando el
 * `SecretsProvider` proporcionado. No lanza si los valores faltan: aplica
 * defaults conservadores compatibles con producción y con pruebas locales.
 */
export function resolveLoggerConfigFromEnv(
  provider: SecretsProvider = defaultSecretsProvider,
): Required<Pick<LoggerFactoryOptions, 'level' | 'filePath' | 'service'>> & {
  rotation: LogRotationConfig;
} {
  const level = parseLogLevel(provider.getSecret('LOG_LEVEL')) ?? 'info';
  const filePath = provider.getSecret('LOG_FILE_PATH') ?? DEFAULT_LOG_FILE_PATH;
  const service = provider.getSecret('LOG_SERVICE_NAME') ?? DEFAULT_SERVICE_NAME;

  const frequency = provider.getSecret('LOG_ROTATION_FREQUENCY') ?? DEFAULT_ROTATION_FREQUENCY;
  const size = provider.getSecret('LOG_ROTATION_SIZE') ?? DEFAULT_ROTATION_SIZE;
  const limitRaw = provider.getSecret('LOG_ROTATION_LIMIT');
  const limit = parsePositiveInteger(limitRaw) ?? DEFAULT_ROTATION_LIMIT;

  return {
    level,
    filePath,
    service,
    rotation: { frequency, size, limit },
  };
}


/**
 * Construye una instancia de `pino` lista para producción o pruebas.
 *
 * - Si `options.destination` está presente, escribe en ese stream (útil en tests).
 * - Si no hay destino inyectado, delega la escritura al transporte `pino-roll`,
 *   que rota el archivo por frecuencia y tamaño según la configuración.
 *
 * Todo objeto que el consumidor pase como merging object será saneado por
 * `redactSensitiveFields` antes de escribirse, garantizando que ninguna clave
 * sensible viaje al archivo de log.
 */
export function createLogger(options: LoggerFactoryOptions = {}): Logger {
  const resolved = mergeOptionsWithEnv(options);
  const pinoOptions = buildPinoOptions(resolved);

  if (options.destination) {
    return pino(pinoOptions, options.destination);
  }

  const absoluteFilePath = ensureLogDirectory(resolved.filePath, resolved.createDirectory);

  const transport = pino.transport({
    target: 'pino-roll',
    options: {
      file: absoluteFilePath,
      frequency: resolved.rotation.frequency,
      size: resolved.rotation.size,
      limit: { count: resolved.rotation.limit },
      mkdir: resolved.createDirectory,
    },
  });

  return pino(pinoOptions, transport);
}

/**
 * Combina las opciones recibidas por la fábrica con los valores resueltos
 * desde el entorno, dejando siempre prioridad a lo que el consumidor pasa
 * de forma explícita.
 */
function mergeOptionsWithEnv(options: LoggerFactoryOptions): {
  service: string;
  level: LogLevel;
  filePath: string;
  rotation: LogRotationConfig;
  baseFields: Record<string, unknown>;
  createDirectory: boolean;
} {
  const provider = options.secretsProvider ?? defaultSecretsProvider;
  const envConfig = resolveLoggerConfigFromEnv(provider);

  const level = options.level ?? envConfig.level;
  if (!isValidLogLevel(level)) {
    throw new Error(`LOG_LEVEL no válido: ${level}`);
  }

  return {
    service: options.service ?? envConfig.service,
    level,
    filePath: options.filePath ?? envConfig.filePath,
    rotation: {
      frequency: options.rotation?.frequency ?? envConfig.rotation.frequency,
      size: options.rotation?.size ?? envConfig.rotation.size,
      limit: options.rotation?.limit ?? envConfig.rotation.limit,
    },
    baseFields: options.baseFields ?? {},
    createDirectory: options.createDirectory ?? true,
  };
}

/**
 * Genera las opciones base de `pino`: nivel textual, timestamp ISO-8601,
 * formato de nivel legible, campos base compartidos y saneamiento defensivo.
 */
function buildPinoOptions(config: {
  service: string;
  level: LogLevel;
  baseFields: Record<string, unknown>;
}): PinoOptions {
  return {
    level: config.level,
    base: {
      service: config.service,
      ...config.baseFields,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
    formatters: {
      /** Serializa el nivel como cadena legible en lugar del número interno de pino. */
      level(label: string): Record<string, unknown> {
        return { level: label };
      },
      /**
       * Sanea los objetos entregados por el consumidor antes de escribirlos.
       * Cualquier campo cuyo nombre coincida con `SENSITIVE_FIELD_KEYWORDS`
       * se reemplaza por `REDACTED_PLACEHOLDER` para evitar filtrar secretos.
       */
      log(obj: Record<string, unknown>): Record<string, unknown> {
        return redactSensitiveFields(obj);
      },
    },
    redact: {
      paths: buildRedactPaths(),
      censor: REDACTED_PLACEHOLDER,
    },
    serializers: {
      /**
       * Serializador dedicado para el campo `err`. Convierte el `Error` en un
       * objeto plano y saneado, garantizando que ni el stack ni la causa
       * filtren secretos y que siempre exista `message`, `type` y `stack`.
       */
      err(err: unknown): Record<string, unknown> {
        return serializeError(err);
      },
    },
  };
}

/**
 * Genera las rutas de redacción nativa de `pino` como capa adicional. Cubre
 * campos superficiales cuya clave coincide con los términos sensibles.
 */
function buildRedactPaths(): string[] {
  const paths: string[] = [];
  for (const keyword of SENSITIVE_FIELD_KEYWORDS) {
    paths.push(keyword);
    paths.push(`*.${keyword}`);
  }
  return paths;
}

/**
 * Convierte el `filePath` recibido en una ruta absoluta y asegura que su
 * directorio padre existe. Devuelve la ruta absoluta usable por `pino-roll`.
 */
function ensureLogDirectory(filePath: string, createDirectory: boolean): string {
  const absolute = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  if (createDirectory) {
    mkdirSync(dirname(absolute), { recursive: true });
  }
  return absolute;
}

/**
 * Valida y normaliza un nivel de log recibido como cadena. Devuelve
 * `undefined` si el valor no coincide con ninguno de los niveles válidos.
 */
function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return isValidLogLevel(normalized) ? (normalized as LogLevel) : undefined;
}

/** Comprueba si un valor arbitrario coincide exactamente con un nivel válido de `pino`. */
function isValidLogLevel(value: string | undefined): value is LogLevel {
  if (!value) {
    return false;
  }
  return (VALID_LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Parsea un entero positivo desde una cadena. Devuelve `undefined` cuando la
 * entrada es vacía, no numérica o menor o igual a cero.
 */
function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

/**
 * Campos comunes que identifican la transacción a la que pertenece un log.
 * Se propagan a través del `child` logger para que cada línea derivada
 * conserve el `transactionId` exigido por AGENT.md y RF-05 del spec.
 */
export interface TransactionContext {
  /** Identificador único de la operación (uuid, hash, o clave interna). */
  transactionId: string;
  /** Descriptor legible de la ruta de arbitraje (opcional). */
  route?: string;
  /** Par o mercado sobre el que se opera (opcional, ejemplo `SOL/USDC`). */
  pair?: string;
  /** Campos adicionales de contexto que el consumidor quiera propagar. */
  [key: string]: unknown;
}

/**
 * Unión discriminada con los eventos de ciclo de vida de una transacción.
 * `logTransactionEvent` los mapea al nivel de log correcto y garantiza la
 * presencia de los campos exigidos por el criterio de aceptación de 5.2.
 */
export type TransactionEvent =
  | ({ status: 'started'; expectedProfit?: number | string } & TransactionContext)
  | ({
      status: 'succeeded';
      profit: number | string;
      signatures?: string[];
      slot?: number;
      bundleId?: string;
      durationMs?: number;
    } & TransactionContext)
  | ({
      status: 'failed';
      error: unknown;
      reason?: string;
      attempts?: number;
      bundleId?: string;
      durationMs?: number;
    } & TransactionContext);

/**
 * Devuelve un logger hijo que preserva el `transactionId` (y campos extra)
 * en cada línea emitida. Cualquier valor sensible en `extras` se saneará
 * a través del formatter global registrado en `buildPinoOptions`.
 */
export function withTransactionContext(
  logger: Logger,
  transactionId: string,
  extras: Omit<TransactionContext, 'transactionId'> = {},
): Logger {
  if (!transactionId || transactionId.trim().length === 0) {
    throw new Error('transactionId es obligatorio para withTransactionContext');
  }
  return logger.child({ transactionId, ...extras });
}

/**
 * Registra un evento de ciclo de vida de transacción en el nivel adecuado:
 * `info` para `started`/`succeeded` y `warn` para `failed`. Garantiza que
 * el `error` de un fallo viaje siempre bajo la clave `err` para que el
 * serializador dedicado lo transforme y sanee.
 */
export function logTransactionEvent(logger: Logger, event: TransactionEvent): void {
  const scoped = withTransactionContext(logger, event.transactionId, extractContextExtras(event));

  if (event.status === 'started') {
    const payload = pickDefined({ expectedProfit: event.expectedProfit });
    scoped.info(payload, 'transaction:started');
    return;
  }

  if (event.status === 'succeeded') {
    const payload = pickDefined({
      profit: event.profit,
      signatures: event.signatures,
      slot: event.slot,
      bundleId: event.bundleId,
      durationMs: event.durationMs,
    });
    scoped.info(payload, 'transaction:succeeded');
    return;
  }

  const payload = pickDefined({
    err: serializeError(event.error),
    reason: event.reason,
    attempts: event.attempts,
    bundleId: event.bundleId,
    durationMs: event.durationMs,
  });
  scoped.warn(payload, 'transaction:failed');
}

/**
 * Convierte cualquier valor recibido como `error` en un objeto plano y
 * saneado apto para serializarse en el log. Soporta `Error`, objetos
 * arbitrarios, cadenas y valores primitivos.
 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const base: Record<string, unknown> = {
      type: err.name || 'Error',
      message: err.message,
      stack: err.stack,
    };
    const anyErr = err as Error & { code?: unknown; cause?: unknown };
    if (anyErr.code !== undefined) {
      base.code = anyErr.code;
    }
    if (anyErr.cause !== undefined) {
      base.cause = serializeError(anyErr.cause);
    }
    for (const key of Object.keys(err)) {
      if (key === 'name' || key === 'message' || key === 'stack' || key === 'code' || key === 'cause') {
        continue;
      }
      base[key] = (err as unknown as Record<string, unknown>)[key];
    }
    return redactSensitiveFields(base);
  }

  if (typeof err === 'string') {
    return { type: 'String', message: err };
  }

  if (err && typeof err === 'object') {
    return redactSensitiveFields({ type: 'Object', ...(err as Record<string, unknown>) });
  }

  return { type: typeof err, message: String(err) };
}

/**
 * Extrae los campos de `TransactionContext` de un evento, descartando las
 * propiedades específicas del estado (status, profit, error, etc.) para no
 * duplicarlas en el `child` logger.
 */
function extractContextExtras(event: TransactionEvent): Omit<TransactionContext, 'transactionId'> {
  const reserved = new Set([
    'status',
    'transactionId',
    'profit',
    'error',
    'signatures',
    'slot',
    'bundleId',
    'durationMs',
    'reason',
    'attempts',
    'expectedProfit',
  ]);
  const extras: Record<string, unknown> = {};
  for (const key of Object.keys(event)) {
    if (reserved.has(key)) {
      continue;
    }
    extras[key] = (event as unknown as Record<string, unknown>)[key];
  }
  return extras;
}

/**
 * Filtra un objeto para conservar únicamente los pares cuyo valor no sea
 * `undefined`. Evita ensuciar los logs con campos vacíos.
 */
function pickDefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (input[key] !== undefined) {
      output[key] = input[key];
    }
  }
  return output as Partial<T>;
}
