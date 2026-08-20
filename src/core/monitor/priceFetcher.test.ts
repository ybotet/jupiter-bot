import test from 'node:test';
import assert from 'node:assert/strict';

import type { QuoteGetRequest, QuoteResponse } from '@jup-ag/api';

import {
  PriceFetcher,
  SOL_MINT,
  USDC_MINT,
  USDT_MINT,
  type JupiterQuoteClient,
  type MarketPair,
} from './priceFetcher';

/** Builds a valid Jupiter quote fixture for a monitored pair. */
function createQuote(outputMint: string, outAmount: string): QuoteResponse {
  return {
    inputMint: SOL_MINT,
    inAmount: '1000000000',
    outputMint,
    outAmount,
    otherAmountThreshold: outAmount,
    swapMode: 'ExactIn',
    slippageBps: 50,
    priceImpactPct: '0.04',
    routePlan: [],
  };
}

/** Creates a typed Jupiter client mock and records every request. */
function createMockClient(quotes: Record<MarketPair, QuoteResponse>): {
  client: JupiterQuoteClient;
  requests: QuoteGetRequest[];
} {
  const requests: QuoteGetRequest[] = [];
  const client: JupiterQuoteClient = {
    quoteGet: async (request) => {
      requests.push(request);
      return quotes[request.outputMint === USDC_MINT ? 'SOL/USDC' : 'SOL/USDT'];
    },
  };

  return { client, requests };
}

/** Verifies that a Jupiter quote becomes a normalized SOL/USDC price snapshot. */
test('PriceFetcher normalizes a mocked Jupiter quote', async () => {
  const { client, requests } = createMockClient({
    'SOL/USDC': createQuote(USDC_MINT, '1700000000'),
    'SOL/USDT': createQuote(USDT_MINT, '1695000000'),
  });
  const fetcher = new PriceFetcher(200, client);

  const snapshot = await fetcher.fetchPrice('SOL/USDC');

  assert.equal(snapshot.pair, 'SOL/USDC');
  assert.equal(snapshot.dex, 'Jupiter');
  assert.equal(snapshot.inputMint, SOL_MINT);
  assert.equal(snapshot.outputMint, USDC_MINT);
  assert.equal(snapshot.rawOutput, 1700000000);
  assert.equal(snapshot.price, 1700);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amount: 1000000000,
    slippageBps: 50,
    swapMode: 'ExactIn',
  });
});

/** Verifies that both configured pairs are requested concurrently and returned. */
test('PriceFetcher fetches both monitored pairs with the Jupiter mock', async () => {
  const { client, requests } = createMockClient({
    'SOL/USDC': createQuote(USDC_MINT, '1700000000'),
    'SOL/USDT': createQuote(USDT_MINT, '1695000000'),
  });
  const fetcher = new PriceFetcher(200, client);

  const prices = await fetcher.fetchAll();

  assert.equal(prices['SOL/USDC'].price, 1700);
  assert.equal(prices['SOL/USDT'].price, 1695);
  assert.deepEqual(
    requests.map((request) => request.outputMint).sort(),
    [USDC_MINT, USDT_MINT].sort(),
  );
});

/** Verifies that a repeated request within the 200ms TTL does not call Jupiter twice. */
test('PriceFetcher reuses a mocked quote within the 200ms cache TTL', async () => {
  const { client, requests } = createMockClient({
    'SOL/USDC': createQuote(USDC_MINT, '1700000000'),
    'SOL/USDT': createQuote(USDT_MINT, '1695000000'),
  });
  const fetcher = new PriceFetcher(200, client);

  const first = await fetcher.fetchPrice('SOL/USDC');
  const second = await fetcher.fetchPrice('SOL/USDC');

  assert.equal(first.price, second.price);
  assert.equal(requests.length, 1);
});

/** Verifies that an upstream Jupiter failure returns a safe fallback snapshot. */
test('PriceFetcher returns fallback snapshots when Jupiter fails', async () => {
  const failingClient: JupiterQuoteClient = {
    quoteGet: async () => {
      throw new Error('Jupiter unavailable');
    },
  };
  const fetcher = new PriceFetcher(200, failingClient);

  const snapshot = await fetcher.fetchPrice('SOL/USDC');

  assert.equal(snapshot.pair, 'SOL/USDC');
  assert.equal(snapshot.price, 0);
  assert.equal(snapshot.rawOutput, 0);
  assert.equal(snapshot.dex, 'Jupiter');
});

/** Verifies that polling can start and stop without leaving an active timer. */
test('PriceFetcher starts and stops polling safely', () => {
  const { client } = createMockClient({
    'SOL/USDC': createQuote(USDC_MINT, '1700000000'),
    'SOL/USDT': createQuote(USDT_MINT, '1695000000'),
  });
  const fetcher = new PriceFetcher(200, client);

  fetcher.start();
  fetcher.start();
  fetcher.stop();
  fetcher.stop();

  assert.equal(fetcher.getLatestPrices()['SOL/USDC'].pair, 'SOL/USDC');
});
