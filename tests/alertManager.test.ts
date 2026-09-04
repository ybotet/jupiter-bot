/**
 * Pruebas unitarias de aceptación para el sistema de alertas.
 *
 * Cumple con el criterio de la Tarea 5.4: "Las pruebas validan el envío de
 * alertas" con mocks. Se inyectan tres tipos de dobles:
 *   - `AlertChannel` en memoria para observar qué recibe el manager.
 *   - `FetchLike` en memoria para observar los envíos HTTP a Telegram y Slack
 *     sin salir a la red.
 *   - `SecretsProvider` en memoria para verificar `createAlertManagerFromEnv`
 *     sin tocar `process.env`.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  AlertManager,
  DEFAULT_ALERT_MIN_LEVEL,
  SlackAlertChannel,
  TELEGRAM_DEFAULT_BASE_URL,
  TelegramAlertChannel,
  createAlertManagerFromEnv,
  type AlertChannel,
  type AlertPayload,
  type FetchLike,
} from '../src/utils/alertManager';
import { REDACTED_PLACEHOLDER, type SecretsProvider } from '../src/utils/secrets';

/** Provider en memoria: mock del `.env` para los tests de la fábrica. */
class InMemorySecretsProvider implements SecretsProvider {
  private readonly secrets: Map<string, string>;

  constructor(secrets: Record<string, string> = {}) {
    this.secrets = new Map(Object.entries(secrets));
  }

  public getSecret(name: string): string | undefined {
    return this.secrets.get(name);
  }
}

/** Payload de alerta reutilizable para las pruebas. */
const basePayload: AlertPayload = {
  event: 'transaction_failed',
  level: 'error',
  title: 'Bundle rechazado',
  message: 'El relay devolvió simulationFailure',
  transactionId: 'tx-abc',
  metadata: { bundleId: 'bundle-1', attempts: 3 },
};

/**
 * Construye un doble de `fetch` que registra cada llamada y responde con el
 * status configurado. No realiza ninguna petición real de red.
 */
function createFetchDouble(
  response: { ok: boolean; status?: number; statusText?: string } = { ok: true },
): {
  fetch: FetchLike;
  calls: Array<{ url: string; body?: string; headers?: Record<string, string> }>;
} {
  const calls: Array<{ url: string; body?: string; headers?: Record<string, string> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body, headers: init?.headers });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      statusText: response.statusText ?? (response.ok ? 'OK' : 'Server Error'),
      text: async () => '',
    };
  };
  return { fetch: fetchImpl, calls };
}

/**
 * Doble de `AlertChannel` en memoria. Guarda los payloads recibidos y, si se
 * pide, lanza un error para probar la resiliencia del `AlertManager`.
 */
function createRecordingChannel(
  name: string,
  options: { fail?: boolean } = {},
): { channel: AlertChannel; received: AlertPayload[] } {
  const received: AlertPayload[] = [];
  const channel: AlertChannel = {
    name,
    async send(payload) {
      received.push(payload);
      if (options.fail) {
        throw new Error(`${name} rechazó la alerta`);
      }
    },
  };
  return { channel, received };
}

test('AlertManager entrega la alerta a cada canal registrado y añade timestamp por defecto', async () => {
  const first = createRecordingChannel('primary');
  const second = createRecordingChannel('secondary');
  const manager = new AlertManager({ channels: [first.channel, second.channel] });

  await manager.notify({ ...basePayload });

  assert.equal(first.received.length, 1);
  assert.equal(second.received.length, 1);
  assert.equal(first.received[0].transactionId, 'tx-abc');
  assert.equal(typeof first.received[0].timestamp, 'string');
  assert.ok(!Number.isNaN(Date.parse(first.received[0].timestamp as string)));
});

test('AlertManager descarta alertas por debajo del umbral mínimo configurado', async () => {
  const { channel, received } = createRecordingChannel('primary');
  const manager = new AlertManager({ channels: [channel], minLevel: 'error' });

  await manager.notify({ ...basePayload, level: 'info' });
  await manager.notify({ ...basePayload, level: 'warn' });
  await manager.notify({ ...basePayload, level: 'error' });
  await manager.notify({ ...basePayload, level: 'critical' });

  assert.equal(received.length, 2);
  assert.deepEqual(
    received.map((r) => r.level),
    ['error', 'critical'],
  );
});

test('AlertManager sanea la metadata sensible antes de propagar la alerta al canal', async () => {
  const { channel, received } = createRecordingChannel('primary');
  const manager = new AlertManager({ channels: [channel] });

  await manager.notify({
    ...basePayload,
    metadata: {
      privateKey: 'no-debe-aparecer',
      wallet: { secretKey: 'tampoco' },
      bundleId: 'bundle-9',
    },
  });

  const metadata = received[0].metadata as Record<string, unknown>;
  assert.equal(metadata.privateKey, REDACTED_PLACEHOLDER);
  const wallet = metadata.wallet as Record<string, unknown>;
  assert.equal(wallet.secretKey, REDACTED_PLACEHOLDER);
  assert.equal(metadata.bundleId, 'bundle-9');
});

test('AlertManager tolera un canal caído y sigue entregando al resto', async () => {
  const broken = createRecordingChannel('broken', { fail: true });
  const healthy = createRecordingChannel('healthy');
  const manager = new AlertManager({ channels: [broken.channel, healthy.channel] });

  await manager.notify({ ...basePayload });

  assert.equal(broken.received.length, 1);
  assert.equal(healthy.received.length, 1);
});

test('TelegramAlertChannel envía POST /bot<token>/sendMessage con chat_id y text', async () => {
  const { fetch, calls } = createFetchDouble({ ok: true });
  const channel = new TelegramAlertChannel({
    botToken: 'test-token',
    chatId: '123456',
    fetchImpl: fetch,
  });

  await channel.send({ ...basePayload });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${TELEGRAM_DEFAULT_BASE_URL}/bottest-token/sendMessage`);
  const body = JSON.parse(calls[0].body as string) as Record<string, unknown>;
  assert.equal(body.chat_id, '123456');
  assert.ok(typeof body.text === 'string');
  assert.match(body.text as string, /Bundle rechazado/);
  assert.match(body.text as string, /transactionId: tx-abc/);
});

test('TelegramAlertChannel lanza un error saneado sin exponer el token cuando la API responde no-2xx', async () => {
  const { fetch } = createFetchDouble({ ok: false, status: 401, statusText: 'Unauthorized' });
  const channel = new TelegramAlertChannel({
    botToken: 'super-secreto',
    chatId: '999',
    fetchImpl: fetch,
  });

  await assert.rejects(channel.send({ ...basePayload }), (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, /status 401/);
    assert.ok(!message.includes('super-secreto'), 'el token no debe aparecer en el error');
    return true;
  });
});

test('TelegramAlertChannel rechaza configuraciones incompletas en el constructor', () => {
  assert.throws(
    () =>
      new TelegramAlertChannel({
        botToken: '',
        chatId: '1',
        fetchImpl: createFetchDouble().fetch,
      }),
    /botToken/,
  );
  assert.throws(
    () =>
      new TelegramAlertChannel({
        botToken: 't',
        chatId: '   ',
        fetchImpl: createFetchDouble().fetch,
      }),
    /chatId/,
  );
});

test('SlackAlertChannel envía el payload como JSON { text } al webhook configurado', async () => {
  const { fetch, calls } = createFetchDouble({ ok: true });
  const channel = new SlackAlertChannel({
    webhookUrl: 'https://hooks.slack.com/services/T000/B000/xyz',
    fetchImpl: fetch,
  });

  await channel.send({ ...basePayload });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hooks.slack.com/services/T000/B000/xyz');
  const body = JSON.parse(calls[0].body as string) as Record<string, unknown>;
  assert.ok(typeof body.text === 'string');
  assert.match(body.text as string, /Bundle rechazado/);
});

test('SlackAlertChannel lanza un error saneado sin filtrar la URL secreta del webhook', async () => {
  const secretUrl = 'https://hooks.slack.com/services/T000/B000/superSecretToken';
  const { fetch } = createFetchDouble({ ok: false, status: 500, statusText: 'Server Error' });
  const channel = new SlackAlertChannel({ webhookUrl: secretUrl, fetchImpl: fetch });

  await assert.rejects(channel.send({ ...basePayload }), (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, /status 500/);
    assert.ok(
      !message.includes('superSecretToken'),
      'la URL secreta del webhook no debe aparecer en el error',
    );
    return true;
  });
});

test('createAlertManagerFromEnv instancia solo los canales cuya configuración esté completa', () => {
  const provider = new InMemorySecretsProvider({
    TELEGRAM_BOT_TOKEN: 'abc',
    TELEGRAM_CHAT_ID: '999',
    SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x',
    ALERT_MIN_LEVEL: 'error',
  });

  const manager = createAlertManagerFromEnv(provider, {
    fetchImpl: createFetchDouble().fetch,
  });
  const channels = manager.getChannels();

  assert.equal(channels.length, 2);
  assert.deepEqual(
    channels.map((c) => c.name).sort(),
    ['slack', 'telegram'],
  );
});

test('createAlertManagerFromEnv devuelve un manager sin canales cuando faltan variables clave', () => {
  const provider = new InMemorySecretsProvider({
    // Falta TELEGRAM_CHAT_ID; el canal Telegram no debe instanciarse.
    TELEGRAM_BOT_TOKEN: 'solo-token',
  });

  const manager = createAlertManagerFromEnv(provider, {
    fetchImpl: createFetchDouble().fetch,
  });

  assert.equal(manager.getChannels().length, 0);
});

test('DEFAULT_ALERT_MIN_LEVEL expone el umbral por defecto documentado', () => {
  assert.equal(DEFAULT_ALERT_MIN_LEVEL, 'warn');
});

