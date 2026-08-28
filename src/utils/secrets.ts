import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { config as loadDotenv } from 'dotenv';

/** Marcador que sustituye a cualquier secreto detectado durante el saneamiento de logs. */
export const REDACTED_PLACEHOLDER = '***REDACTED***';

/** Variable de entorno por defecto donde se espera la clave privada del bot. */
export const PRIVATE_KEY_ENV = 'PRIVATE_KEY';

/**
 * Conjunto de nombres de campos considerados sensibles a la hora de serializar objetos
 * para logs. Se comparan en minúsculas y de forma parcial (`includes`).
 */
export const SENSITIVE_FIELD_KEYWORDS = [
  'privatekey',
  'private_key',
  'secretkey',
  'secret_key',
  'secret',
  'mnemonic',
  'seed',
  'password',
  'apikey',
  'api_key',
  'token',
  'authorization',
];

/** Estado interno que asegura que `dotenv.config` se ejecute una única vez por proceso. */
let dotenvInitialized = false;

/**
 * Inicializa `dotenv` la primera vez que se invoca. Los procesos que arranquen
 * el bot pueden llamar a esta función en el bootstrap para cargar el `.env`.
 */
export function loadEnv(): void {
  if (dotenvInitialized) {
    return;
  }
  loadDotenv();
  dotenvInitialized = true;
}

/** Fuente de secretos que puede intercambiarse (`.env`, AWS Secrets Manager, etc.). */
export interface SecretsProvider {
  /** Recupera un secreto por nombre. Devuelve `undefined` si no existe o si su valor es vacío. */
  getSecret(name: string): string | undefined;
}

/**
 * Implementación por defecto que resuelve secretos desde `process.env`.
 * Recorta espacios y trata cadenas vacías como ausentes para evitar firmar con basura.
 */
export class EnvSecretsProvider implements SecretsProvider {
  /** Construye el provider asegurando que el `.env` esté cargado antes de la primera lectura. */
  constructor() {
    loadEnv();
  }

  /** Devuelve el secreto normalizado o `undefined` cuando la variable no está definida. */
  public getSecret(name: string): string | undefined {
    const raw = process.env[name];
    if (raw === undefined) {
      return undefined;
    }
    const trimmed = raw.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
}

/** Provider por defecto reutilizable en todo el proyecto. */
export const defaultSecretsProvider: SecretsProvider = new EnvSecretsProvider();

/**
 * Convierte una cadena secreta (base58 o array JSON) en una `Keypair` de Solana
 * sin exponer su contenido en logs ni en los mensajes de error.
 */
export function loadKeypair(source: string | undefined): Keypair {
  if (!source) {
    throw new Error(`${PRIVATE_KEY_ENV} no está configurada`);
  }

  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new Error(`${PRIVATE_KEY_ENV} está vacía tras eliminar espacios`);
  }

  try {
    const secretKey = trimmed.startsWith('[')
      ? Uint8Array.from(JSON.parse(trimmed) as number[])
      : bs58.decode(trimmed);
    return Keypair.fromSecretKey(secretKey);
  } catch {
    throw new Error(`${PRIVATE_KEY_ENV} no tiene un formato válido`);
  }
}

/**
 * Carga la `Keypair` desde una variable de entorno usando el `SecretsProvider` indicado.
 * Nunca registra ni devuelve el valor original de la variable de entorno.
 */
export function loadKeypairFromEnv(
  envVar: string = PRIVATE_KEY_ENV,
  provider: SecretsProvider = defaultSecretsProvider,
): Keypair {
  const secret = provider.getSecret(envVar);
  if (!secret) {
    throw new Error(`${envVar} no está configurada`);
  }
  return loadKeypair(secret);
}

/** Devuelve una versión redactada de una cadena secreta apta para logs de auditoría. */
export function redactSecret(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    return REDACTED_PLACEHOLDER;
  }
  return REDACTED_PLACEHOLDER;
}

/**
 * Determina si el nombre de un campo debe considerarse sensible comparándolo
 * en minúsculas contra la lista `SENSITIVE_FIELD_KEYWORDS`.
 */
export function isSensitiveFieldName(fieldName: string): boolean {
  const normalized = fieldName.toLowerCase();
  return SENSITIVE_FIELD_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/**
 * Recorre un objeto o array de forma recursiva y reemplaza los valores de los
 * campos considerados sensibles por el marcador `REDACTED_PLACEHOLDER`.
 * Devuelve una copia sin mutar la entrada; útil para serializar hacia `pino`/`winston`.
 */
export function redactSensitiveFields<T>(input: T): T {
  return redactValue(input) as T;
}

/** Función auxiliar recursiva que redacta valores manteniendo referencias circulares fuera de la copia. */
function redactValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return REDACTED_PLACEHOLDER;
    }
    seen.add(value);
    return value.map((item) => redactValue(item, seen));
  }

  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    if (seen.has(objectValue)) {
      return REDACTED_PLACEHOLDER;
    }
    seen.add(objectValue);
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(objectValue)) {
      if (isSensitiveFieldName(key)) {
        clone[key] = REDACTED_PLACEHOLDER;
        continue;
      }
      clone[key] = redactValue(objectValue[key], seen);
    }
    return clone;
  }

  return value;
}
