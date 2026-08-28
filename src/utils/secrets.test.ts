import test from 'node:test';
import assert from 'node:assert/strict';

import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

import {
  EnvSecretsProvider,
  PRIVATE_KEY_ENV,
  REDACTED_PLACEHOLDER,
  isSensitiveFieldName,
  loadKeypair,
  loadKeypairFromEnv,
  redactSecret,
  redactSensitiveFields,
  type SecretsProvider,
} from './secrets';

/** Provider en memoria para probar la carga de claves sin tocar `process.env`. */
class InMemorySecretsProvider implements SecretsProvider {
  private readonly secrets: Map<string, string>;

  constructor(secrets: Record<string, string> = {}) {
    this.secrets = new Map(Object.entries(secrets));
  }

  public getSecret(name: string): string | undefined {
    return this.secrets.get(name);
  }
}

/** Verifica que `loadKeypair` acepte claves en formato base58. */
test('loadKeypair decodifica una clave base58 válida', () => {
  const original = Keypair.generate();
  const encoded = bs58.encode(original.secretKey);
  const result = loadKeypair(encoded);
  assert.equal(result.publicKey.toBase58(), original.publicKey.toBase58());
});

/** Verifica que `loadKeypair` acepte claves en formato JSON array (solana-keygen). */
test('loadKeypair decodifica una clave en formato JSON array', () => {
  const original = Keypair.generate();
  const encoded = JSON.stringify(Array.from(original.secretKey));
  const result = loadKeypair(encoded);
  assert.equal(result.publicKey.toBase58(), original.publicKey.toBase58());
});

/** Verifica que `loadKeypair` rechace claves ausentes o vacías con mensajes claros. */
test('loadKeypair lanza un error legible cuando la clave está ausente o vacía', () => {
  assert.throws(() => loadKeypair(undefined), new RegExp(`${PRIVATE_KEY_ENV} no está configurada`));
  assert.throws(() => loadKeypair('   '), new RegExp(`${PRIVATE_KEY_ENV} está vacía`));
});

/** Verifica que `loadKeypair` no exponga el valor de la clave cuando el formato es inválido. */
test('loadKeypair no filtra la clave privada en el mensaje de error', () => {
  const sneaky = 'this-is-not-a-valid-key-987654321';
  try {
    loadKeypair(sneaky);
    assert.fail('Se esperaba una excepción por formato inválido');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(!message.includes(sneaky), 'El mensaje de error filtró el valor de la clave privada');
    assert.match(message, new RegExp(`${PRIVATE_KEY_ENV} no tiene un formato válido`));
  }
});

/** Verifica que `loadKeypairFromEnv` use un provider inyectado sin tocar `process.env`. */
test('loadKeypairFromEnv resuelve la clave usando un SecretsProvider inyectado', () => {
  const original = Keypair.generate();
  const provider = new InMemorySecretsProvider({
    [PRIVATE_KEY_ENV]: bs58.encode(original.secretKey),
  });
  const result = loadKeypairFromEnv(PRIVATE_KEY_ENV, provider);
  assert.equal(result.publicKey.toBase58(), original.publicKey.toBase58());
});

/** Verifica que `loadKeypairFromEnv` falle sin exponer el nombre de la variable como valor. */
test('loadKeypairFromEnv falla cuando la variable no existe en el provider', () => {
  const provider = new InMemorySecretsProvider();
  assert.throws(
    () => loadKeypairFromEnv('CUSTOM_KEY', provider),
    /CUSTOM_KEY no está configurada/,
  );
});

/** Verifica que `EnvSecretsProvider` normalice espacios y trate cadenas vacías como ausentes. */
test('EnvSecretsProvider ignora variables definidas como cadena vacía o solo espacios', () => {
  process.env.__SECRETS_TEST_EMPTY__ = '   ';
  process.env.__SECRETS_TEST_VALUE__ = '  hello  ';
  try {
    const provider = new EnvSecretsProvider();
    assert.equal(provider.getSecret('__SECRETS_TEST_EMPTY__'), undefined);
    assert.equal(provider.getSecret('__SECRETS_TEST_VALUE__'), 'hello');
    assert.equal(provider.getSecret('__SECRETS_TEST_MISSING__'), undefined);
  } finally {
    delete process.env.__SECRETS_TEST_EMPTY__;
    delete process.env.__SECRETS_TEST_VALUE__;
  }
});

/** Verifica que `redactSecret` siempre devuelva el placeholder, incluso con entrada vacía. */
test('redactSecret devuelve siempre el placeholder', () => {
  assert.equal(redactSecret('super-secret'), REDACTED_PLACEHOLDER);
  assert.equal(redactSecret(''), REDACTED_PLACEHOLDER);
  assert.equal(redactSecret(undefined), REDACTED_PLACEHOLDER);
});

/** Verifica que `isSensitiveFieldName` detecte nombres sensibles habituales. */
test('isSensitiveFieldName identifica campos sensibles habituales', () => {
  assert.equal(isSensitiveFieldName('privateKey'), true);
  assert.equal(isSensitiveFieldName('PRIVATE_KEY'), true);
  assert.equal(isSensitiveFieldName('user_api_key'), true);
  assert.equal(isSensitiveFieldName('authorization'), true);
  assert.equal(isSensitiveFieldName('publicKey'), false);
  assert.equal(isSensitiveFieldName('blockhash'), false);
});

/** Verifica que `redactSensitiveFields` reemplace valores sensibles sin mutar la entrada. */
test('redactSensitiveFields sanea objetos anidados sin mutar la entrada', () => {
  const input = {
    publicKey: 'pk-visible',
    privateKey: 'super-secret',
    nested: {
      apiKey: 'api-secret',
      metadata: {
        password: 'p@ss',
        note: 'ok',
      },
    },
    entries: ['visible', { secret: 'hidden' }],
  };

  const sanitized = redactSensitiveFields(input);

  assert.equal(sanitized.publicKey, 'pk-visible');
  assert.equal(sanitized.privateKey, REDACTED_PLACEHOLDER);
  assert.equal(sanitized.nested.apiKey, REDACTED_PLACEHOLDER);
  assert.equal(sanitized.nested.metadata.password, REDACTED_PLACEHOLDER);
  assert.equal(sanitized.nested.metadata.note, 'ok');
  assert.equal((sanitized.entries[1] as { secret: string }).secret, REDACTED_PLACEHOLDER);
  assert.equal(sanitized.entries[0], 'visible');
  // La entrada original no se modifica.
  assert.equal(input.privateKey, 'super-secret');
  assert.equal(input.nested.metadata.password, 'p@ss');
});

/** Verifica que `redactSensitiveFields` tolere referencias circulares sin desbordar la pila. */
test('redactSensitiveFields tolera referencias circulares', () => {
  const circular: Record<string, unknown> = { name: 'root', secret: 'oops' };
  circular.self = circular;

  const sanitized = redactSensitiveFields(circular) as Record<string, unknown>;
  assert.equal(sanitized.secret, REDACTED_PLACEHOLDER);
  assert.equal(sanitized.self, REDACTED_PLACEHOLDER);
});

