import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_BOT_METRICS,
  InMemoryBotStatusProvider,
  InMemoryOpportunityFeed,
  MAX_OPPORTUNITIES_PER_QUERY,
  registerBotRoutes,
  type BotStatusProvider,
} from './index';

describe('InMemoryBotStatusProvider', () => {
  it('devuelve el estado inicial con las métricas por defecto', () => {
    const provider = new InMemoryBotStatusProvider();
    const status = provider.getStatus();

    assert.equal(status.state, 'starting');
    assert.deepEqual(status.metrics, DEFAULT_BOT_METRICS);
    assert.equal(status.startedAt, undefined);
  });

  it('actualiza el estado y refresca el heartbeat', () => {
    const provider = new InMemoryBotStatusProvider({
      cluster: 'devnet',
      version: '1.0.0',
    });

    provider.updateState('running');
    const status = provider.getStatus();

    assert.equal(status.state, 'running');
    assert.equal(status.cluster, 'devnet');
    assert.equal(status.version, '1.0.0');
    assert.ok(status.lastHeartbeatAt, 'debe generar un heartbeat ISO');
    assert.doesNotThrow(() => new Date(status.lastHeartbeatAt as string));
  });

  it('fusiona métricas parciales sin sobrescribir campos no provistos', () => {
    const provider = new InMemoryBotStatusProvider();
    provider.mergeMetrics({ opportunitiesDetected: 3, netProfitUsdc: '1.25' });
    provider.mergeMetrics({ bundlesConfirmed: 1 });

    const metrics = provider.getStatus().metrics;
    assert.equal(metrics.opportunitiesDetected, 3);
    assert.equal(metrics.netProfitUsdc, '1.25');
    assert.equal(metrics.bundlesConfirmed, 1);
    assert.equal(metrics.bundlesSubmitted, 0);
  });

  it('devuelve una copia del estado (no comparte referencia)', () => {
    const provider = new InMemoryBotStatusProvider();
    const snapshot = provider.getStatus();
    snapshot.metrics.opportunitiesDetected = 999;

    const fresh = provider.getStatus();
    assert.equal(fresh.metrics.opportunitiesDetected, 0);
  });
});

describe('registerBotRoutes', () => {
  it('lanza si no se proporciona statusProvider', () => {
    assert.throws(
      () => registerBotRoutes({ statusProvider: undefined as unknown as BotStatusProvider }),
      /statusProvider es obligatorio/,
    );
  });
});

describe('InMemoryOpportunityFeed', () => {
  /** Helper corto para no repetir campos obligatorios en cada test. */
  const sampleEntry = (overrides: Record<string, unknown> = {}) => ({
    route: 'SOL → USDC → SOL',
    grossProfitUsdc: '0.50',
    netProfitUsdc: '0.35',
    slippageBps: 50,
    ...overrides,
  });

  it('registra oportunidades y autocompleta id + detectedAt cuando faltan', () => {
    const feed = new InMemoryOpportunityFeed();
    const entry = feed.record(sampleEntry());

    assert.ok(entry.id.length > 0, 'debe generar un UUID no vacío');
    assert.doesNotThrow(() => new Date(entry.detectedAt));
    assert.equal(entry.status, 'detected');
    assert.equal(feed.size(), 1);
  });

  it('devuelve las oportunidades ordenadas por detectedAt descendente', () => {
    const feed = new InMemoryOpportunityFeed();
    feed.record(sampleEntry({ id: 'a', detectedAt: '2025-01-01T00:00:00.000Z' }));
    feed.record(sampleEntry({ id: 'b', detectedAt: '2025-01-01T00:00:02.000Z' }));
    feed.record(sampleEntry({ id: 'c', detectedAt: '2025-01-01T00:00:01.000Z' }));

    const recent = feed.getRecent();
    assert.deepEqual(
      recent.map((e) => e.id),
      ['b', 'c', 'a'],
    );
  });

  it('filtra por since (estrictamente mayor) y respeta el límite', () => {
    const feed = new InMemoryOpportunityFeed();
    feed.record(sampleEntry({ id: 'old', detectedAt: '2025-01-01T00:00:00.000Z' }));
    feed.record(sampleEntry({ id: 'mid', detectedAt: '2025-01-01T00:00:05.000Z' }));
    feed.record(sampleEntry({ id: 'new', detectedAt: '2025-01-01T00:00:10.000Z' }));

    const filtered = feed.getRecent({ since: '2025-01-01T00:00:05.000Z' });
    assert.deepEqual(
      filtered.map((e) => e.id),
      ['new'],
    );

    const limited = feed.getRecent({ limit: 2 });
    assert.equal(limited.length, 2);
    assert.equal(limited[0].id, 'new');
    assert.equal(limited[1].id, 'mid');
  });

  it('descarta entradas antiguas al superar la capacidad (FIFO)', () => {
    const feed = new InMemoryOpportunityFeed(2);
    feed.record(sampleEntry({ id: '1' }));
    feed.record(sampleEntry({ id: '2' }));
    feed.record(sampleEntry({ id: '3' }));

    assert.equal(feed.size(), 2);
    const ids = feed.getRecent().map((e) => e.id);
    assert.ok(!ids.includes('1'), 'la más antigua debe haberse descartado');
    assert.ok(ids.includes('2') && ids.includes('3'));
  });

  it('acota el límite pedido al máximo permitido por consulta', () => {
    const feed = new InMemoryOpportunityFeed(1000);
    for (let i = 0; i < 150; i += 1) {
      feed.record(sampleEntry({ id: `o-${i}` }));
    }
    const recent = feed.getRecent({ limit: 500 });
    assert.equal(recent.length, MAX_OPPORTUNITIES_PER_QUERY);
  });

  it('trata un since inválido como "sin filtro" en lugar de fallar', () => {
    const feed = new InMemoryOpportunityFeed();
    feed.record(sampleEntry({ id: 'x' }));
    const recent = feed.getRecent({ since: 'no-es-una-fecha' });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].id, 'x');
  });
});
