import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import {
  InMemoryBotStatusProvider,
  InMemoryOpportunityFeed,
  createApiServer,
  startApiServer,
  type BotStatus,
  type BotStatusProvider,
  type DetectedOpportunity,
  type RunningApiServer,
} from './index';

/**
 * Extrae el puerto asignado por el sistema operativo cuando el servidor se
 * arranca escuchando en el puerto `0`. Sólo se usa dentro de los tests.
 */
function resolvePort(running: RunningApiServer): number {
  const address = running.server.address() as AddressInfo | null;
  return address?.port ?? running.port;
}

describe('createApiServer', () => {
  it('lanza si no se proporciona statusProvider', () => {
    assert.throws(
      () =>
        createApiServer({
          statusProvider: undefined as unknown as BotStatusProvider,
        }),
      /statusProvider es obligatorio/,
    );
  });
});

describe('startApiServer — flujo HTTP end-to-end', () => {
  let running: RunningApiServer;
  let baseUrl: string;
  const provider = new InMemoryBotStatusProvider({
    cluster: 'mainnet-beta',
    version: '1.0.0',
  });
  provider.updateState('running');
  provider.mergeMetrics({ opportunitiesDetected: 2, netProfitUsdc: '0.42' });

  before(async () => {
    running = await startApiServer({
      statusProvider: provider,
      port: 0,
      host: '127.0.0.1',
    });
    baseUrl = `http://127.0.0.1:${resolvePort(running)}`;
  });

  after(async () => {
    await running.close();
  });

  it('GET /status responde con el estado del bot (criterio 6.1)', async () => {
    const response = await fetch(`${baseUrl}/status`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as BotStatus;

    assert.equal(body.state, 'running');
    assert.equal(body.cluster, 'mainnet-beta');
    assert.equal(body.version, '1.0.0');
    assert.equal(body.metrics.opportunitiesDetected, 2);
    assert.equal(body.metrics.netProfitUsdc, '0.42');
  });

  it('GET /api/status expone el mismo payload bajo la ruta REST', async () => {
    const response = await fetch(`${baseUrl}/api/status`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as BotStatus;
    assert.equal(body.state, 'running');
    assert.equal(body.cluster, 'mainnet-beta');
  });

  it('GET /api/health devuelve un payload de liveness', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; timestamp: string };
    assert.equal(body.status, 'ok');
    assert.doesNotThrow(() => new Date(body.timestamp));
  });

  it('devuelve 404 uniforme para rutas desconocidas', async () => {
    const response = await fetch(`${baseUrl}/no-existe`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: string; path: string };
    assert.equal(body.error, 'not_found');
    assert.equal(body.path, '/no-existe');
  });

  it('emite una cabecera X-Request-Id determinista cuando se inyecta la fábrica', async () => {
    let counter = 0;
    const deterministicApp = await startApiServer({
      statusProvider: provider,
      port: 0,
      host: '127.0.0.1',
      requestIdFactory: () => {
        counter += 1;
        return `test-req-${counter}`;
      },
    });
    const localBase = `http://127.0.0.1:${resolvePort(deterministicApp)}`;
    try {
      const response = await fetch(`${localBase}/status`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-request-id'), 'test-req-1');
    } finally {
      await deterministicApp.close();
    }
  });
});

describe('createApiServer — endpoint /opportunities (Tarea 6.4)', () => {
  let running: RunningApiServer;
  let baseUrl: string;
  const provider = new InMemoryBotStatusProvider({ cluster: 'devnet', version: '1.0.0' });
  const feed = new InMemoryOpportunityFeed(50);

  before(async () => {
    // Sembramos tres oportunidades con timestamps deterministas para poder
    // aserzar orden y filtro `since` sin depender del reloj real.
    feed.record({
      id: 'opp-1',
      detectedAt: '2025-01-01T00:00:00.000Z',
      route: 'SOL → USDC → SOL',
      grossProfitUsdc: '0.50',
      netProfitUsdc: '0.30',
      slippageBps: 40,
    });
    feed.record({
      id: 'opp-2',
      detectedAt: '2025-01-01T00:00:05.000Z',
      route: 'SOL → USDT → SOL',
      grossProfitUsdc: '0.80',
      netProfitUsdc: '0.55',
      slippageBps: 50,
      status: 'submitted',
      transactionId: 'tx-123',
    });
    feed.record({
      id: 'opp-3',
      detectedAt: '2025-01-01T00:00:10.000Z',
      route: 'USDC → SOL → USDC',
      grossProfitUsdc: '0.25',
      netProfitUsdc: '0.10',
      slippageBps: 30,
    });

    running = await startApiServer({
      statusProvider: provider,
      opportunityFeed: feed,
      port: 0,
      host: '127.0.0.1',
    });
    baseUrl = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await running.close();
  });

  it('devuelve las oportunidades ordenadas por detectedAt descendente', async () => {
    const response = await fetch(`${baseUrl}/api/opportunities`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      items: DetectedOpportunity[];
      count: number;
      generatedAt: string;
    };

    assert.equal(body.count, 3);
    assert.deepEqual(
      body.items.map((entry) => entry.id),
      ['opp-3', 'opp-2', 'opp-1'],
    );
    assert.doesNotThrow(() => new Date(body.generatedAt));
  });

  it('filtra correctamente con el parámetro ?since', async () => {
    const since = encodeURIComponent('2025-01-01T00:00:05.000Z');
    const response = await fetch(`${baseUrl}/api/opportunities?since=${since}`);
    const body = (await response.json()) as { items: DetectedOpportunity[]; count: number };

    assert.equal(body.count, 1);
    assert.equal(body.items[0].id, 'opp-3');
  });

  it('respeta el parámetro ?limit acotando el resultado', async () => {
    const response = await fetch(`${baseUrl}/api/opportunities?limit=2`);
    const body = (await response.json()) as { items: DetectedOpportunity[]; count: number };

    assert.equal(body.count, 2);
    assert.deepEqual(
      body.items.map((entry) => entry.id),
      ['opp-3', 'opp-2'],
    );
  });

  it('responde con lista vacía cuando no hay feed inyectado', async () => {
    const standalone = await startApiServer({
      statusProvider: provider,
      port: 0,
      host: '127.0.0.1',
    });
    try {
      const localBase = `http://127.0.0.1:${(standalone.server.address() as AddressInfo).port}`;
      const response = await fetch(`${localBase}/api/opportunities`);
      const body = (await response.json()) as { items: DetectedOpportunity[]; count: number };
      assert.equal(response.status, 200);
      assert.equal(body.count, 0);
      assert.deepEqual(body.items, []);
    } finally {
      await standalone.close();
    }
  });
});

describe('createApiServer — saneamiento de secretos', () => {
  it('/status no expone campos sensibles añadidos al proveedor', async () => {
    class LeakyProvider implements BotStatusProvider {
      public getStatus(): BotStatus {
        return {
          state: 'running',
          metrics: {
            opportunitiesDetected: 0,
            bundlesSubmitted: 0,
            bundlesConfirmed: 0,
            bundlesFailed: 0,
            netProfitUsdc: '0',
          },
          // Campo malicioso inyectado por un consumidor mal implementado.
          // Debe salir redactado por `redactSensitiveFields`.
          ...({ privateKey: 'super-secreto-nunca-visible' } as Record<string, unknown>),
        } as BotStatus;
      }
    }

    const running = await startApiServer({
      statusProvider: new LeakyProvider(),
      port: 0,
      host: '127.0.0.1',
    });
    try {
      const response = await fetch(`http://127.0.0.1:${resolvePort(running)}/status`);
      const raw = await response.text();
      assert.doesNotMatch(raw, /super-secreto-nunca-visible/);
    } finally {
      await running.close();
    }
  });
});
