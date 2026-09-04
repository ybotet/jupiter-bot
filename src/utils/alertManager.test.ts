import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AlertManager,
  SlackAlertChannel,
  TELEGRAM_DEFAULT_BASE_URL,
  TelegramAlertChannel,
  createAlertManagerFromEnv,
  type AlertChannel,
  type AlertPayload,
  type FetchLike,
} from './alertManager';
import { REDACTED_PLACEHOLDER, type SecretsProvider } from './secrets';

/** Provider en memoria para simular variables de entorno en las pruebas. */
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
const samplePayload: AlertPayload = {
  event: 'transaction_failed',
  level: 'error',
  title: 'Bundle rechazado',
  message: 'El relay devolvió simulationFailure',
  transactionId: 'tx-abc',
  metadata: { bundleId: 'bundle-1', attempts: 3 },
};

/** Doble de fetch que registra cada llamada y responde con el status indicado. */
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

/** Doble de canal en memoria para probar el AlertManager sin transporte real. */
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

test('AlertManager entrega la alerta a cada canal registrado con timestamp por defecto', async () => {
  const first = createRecordingChannel('primary');
  const second = createRecordingChannel('secondary');
  const manager = new AlertManager({ channels: [first.channel, second.channel] });

  await manager.notify({ ...samplePayload });

  assert.equal(first.received.length, 1);
  assert.equal(second.received.length, 1);
  assert.equal(first.received[0].transactionId, 'tx-abc');
  assert.equal(typeof first.received[0].timestamp, 'string');
  assert.ok(!Number.isNaN(Date.parse(first.received[0].timestamp as string)));
});

test('AlertManager filtra los eventos por debajo del umbral mínimo', async () => {
  const { channel, received } = createRecordingChannel('primary');
  const manager = new AlertManager({ channels: [channel], minLevel: 'error' });

  await manager.notify({ ...samplePayload, level: 'info' });
  await manager.notify({ ...samplePayload, level: 'warn' });
  await manager.notify({ ...samplePayload, level: 'error' });
  await manager.notify({ ...samplePayload, level: 'critical' });

  assert.equal(received.length, 2);
  assert.deepEqual(
    received.map((entry) => entry.level),
    ['error', 'critical'],
  );
});

test('AlertManager sanea la metadata sensible antes de propagarla al canal', async () => {
  const { channel, received } = createRecordingChannel('primary');
  const manager = new AlertManager({ channels: [channel] });

  await manager.notify({
    ...samplePayload,
    metadata: {
      bundleId: 'bundle-2',
      privateKey: 'no-debe-viajar',
      wallet: { secretKey: 'tampoco', publicKey: 'PubKeyOk' },
    },
  });

  const entry = received[0];
  assert.equal(entry.metadata?.bundleId, 'bundle-2');
  assert.equal(entry.metadata?.privateKey, REDACTED_PLACEHOLDER);
  const wallet = entry.metadata?.wallet as Record<string, unknown>;
  assert.equal(wallet.secretKey, REDACTED_PLACEHOLDER);
  assert.equal(wallet.publicKey, 'PubKeyOk');
});

test('AlertManager continúa si un canal falla y no propaga la excepción', async () => {
  const failing = createRecordingChannel('failing', { fail: true });
  const healthy = createRecordingChannel('healthy');
  const manager = new AlertManager({ channels: [failing.channel, healthy.channel] });

  await assert.doesNotReject(manager.notify({ ...samplePayload }));

  assert.equal(failing.received.length, 1);
  assert.equal(healthy.received.length, 1);
});

test('TelegramAlertChannel envía el mensaje al endpoint sendMessage con el chatId configurado', async () => {
  const { fetch, calls } = createFetchDouble({ ok: true });
  const channel = new TelegramAlertChannel({
    botToken: 'test-token',
    chatId: '123456',
    fetchImpl: fetch,
  });

  await channel.send({ ...samplePayload });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${TELEGRAM_DEFAULT_BASE_URL}/bottest-token/sendMessage`);
  const body = JSON.parse(calls[0].body as string) as Record<string, unknown>;
  assert.equal(body.chat_id, '123456');
  assert.ok(typeof body.text === 'string');
  assert.match(body.text as string, /\[ERROR\] Bundle rechazado/);
  assert.match(body.text as string, /transactionId: tx-abc/);
});

test('TelegramAlertChannel lanza un error saneado cuando Telegram responde no-2xx', async () => {
  const { fetch } = createFetchDouble({ ok: false, status: 401, statusText: 'Unauthorized' });
  const channel = new TelegramAlertChannel({
    botToken: 'super-secreto',
    chatId: '999',
    fetchImpl: fetch,
  });

  await assert.rejects(channel.send({ ...samplePayload }), (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, /status 401/);
    assert.ok(!message.includes('super-secreto'), 'el token no debe aparecer en el error');
    return true;
  });
});

test('TelegramAlertChannel rechaza configuraciones incompletas', () => {
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

test('SlackAlertChannel envía el payload como JSON al webhook configurado', async () => {
  const { fetch, calls } = createFetchDouble({ ok: true });
  const channel = new SlackAlertChannel({
    webhookUrl: 'https://hooks.slack.com/services/T000/B000/xyz',
    fetchImpl: fetch,
  });

  await channel.send({ ...samplePayload });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hooks.slack.com/services/T000/B000/xyz');
  const body = JSON.parse(calls[0].body as string) as Record<string, unknown>;
  assert.ok(typeof body.text === 'string');
  assert.match(body.text as string, /Bundle rechazado/);
});

test('SlackAlertChannel lanza error saneado sin exponer la URL secreta', async () => {
  const secretUrl = 'https://hooks.slack.com/services/T000/B000/superSecretToken';
  const { fetch } = createFetchDouble({ ok: false, status: 500, statusText: 'Server Error' });
  const channel = new SlackAlertChannel({ webhookUrl: secretUrl, fetchImpl: fetch });

  await assert.rejects(channel.send({ ...samplePayload }), (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, /status 500/);
    assert.ok(!message.includes('superSecretToken'), 'la URL con token no debe aparecer en el error');
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
  assert.deepEqual(channels.map((c) => c.name).sort(), ['slack', 'telegram']);
});

test('createAlertManagerFromEnv devuelve un manager vacío cuando faltan variables', () => {
  const provider = new InMemorySecretsProvider({
    TELEGRAM_BOT_TOKEN: 'solo-token', // falta TELEGRAM_CHAT_ID
  });

  const manager = createAlertManagerFromEnv(provider, {
    fetchImpl: createFetchDouble().fetch,
  });

  assert.equal(manager.getChannels().length, 0);
});

