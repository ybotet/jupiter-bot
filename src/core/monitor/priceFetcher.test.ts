import test from 'node:test';
import assert from 'node:assert/strict';

import { PriceFetcher } from './priceFetcher';

test('PriceFetcher builds a price snapshot from a Jupiter quote', () => {
  const fetcher = new PriceFetcher();

  const snapshot = (fetcher as any).toSnapshot(
    'SOL/USDC',
    {
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inAmount: 1_000_000_000,
      outAmount: 1_700_000_000,
      otherAmountThreshold: 1_660_000_000,
      swapMode: 'ExactIn',
      slippageBps: 50,
      priceImpactPct: 0.04,
      routePlan: [],
    },
    1_000_000_000,
  );

  assert.equal(snapshot.pair, 'SOL/USDC');
  assert.equal(snapshot.dex, 'Jupiter');
  assert.ok(snapshot.price > 1600 && snapshot.price < 1800, `Unexpected price: ${snapshot.price}`);
});

test('PriceFetcher exposes default snapshots for both monitored pairs', () => {
  const fetcher = new PriceFetcher();
  const prices = fetcher.getLatestPrices();

  assert.ok(prices['SOL/USDC']);
  assert.ok(prices['SOL/USDT']);
  assert.equal(prices['SOL/USDC'].pair, 'SOL/USDC');
  assert.equal(prices['SOL/USDT'].pair, 'SOL/USDT');
});

test('PriceFetcher caches quotes within a 200ms TTL and reuses them before expiry', async () => {
  const fetcher = new PriceFetcher();
  const client = (fetcher as any).client;
  const original = client.quoteGet.bind(client);
  let calls = 0;

  client.quoteGet = async () => {
    calls += 1;
    return {
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inAmount: 1_000_000_000,
      outAmount: 1_700_000_000,
      otherAmountThreshold: 1_660_000_000,
      swapMode: 'ExactIn',
      slippageBps: 50,
      priceImpactPct: 0.04,
      routePlan: [],
    };
  };

  const first = await fetcher.fetchPrice('SOL/USDC');
  const second = await fetcher.fetchPrice('SOL/USDC');

  assert.equal(calls, 1);
  assert.equal(first.price, second.price);

  client.quoteGet = original;
});

test('PriceFetcher handles upstream rate-limit errors without throwing', async () => {
  const fetcher = new PriceFetcher();
  const client = (fetcher as any).client;
  const original = client.quoteGet.bind(client);

  client.quoteGet = async () => {
    throw new Error('429 Too Many Requests');
  };

  await assert.doesNotReject(async () => {
    await (fetcher as any).pollOnce();
  });

  client.quoteGet = original;
});
