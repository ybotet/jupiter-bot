import test from 'node:test';
import assert from 'node:assert/strict';

import type { QuoteGetRequest, QuoteResponse } from '@jup-ag/api';

import {
  ArbitrageCalculator,
  type ArbitrageRoute,
  type JupiterRouteClient,
} from './arbitrageCalculator';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

/** Construye una respuesta Jupiter mínima y tipada para una prueba. */
function createQuote(request: QuoteGetRequest, outAmount: string): QuoteResponse {
  return {
    inputMint: request.inputMint,
    inAmount: String(request.amount),
    outputMint: request.outputMint,
    outAmount,
    otherAmountThreshold: outAmount,
    swapMode: 'ExactIn',
    slippageBps: request.slippageBps ?? 50,
    priceImpactPct: '0',
    routePlan: [],
  };
}

/** Crea un cliente Jupiter falso que registra las consultas y devuelve salidas configuradas. */
function createMockClient(outputs: string[]): {
  client: JupiterRouteClient;
  requests: QuoteGetRequest[];
} {
  const requests: QuoteGetRequest[] = [];
  let callIndex = 0;
  const client: JupiterRouteClient = {
    quoteGet: async (request) => {
      requests.push(request);
      const output = outputs[callIndex];
      callIndex += 1;
      return createQuote(request, output);
    },
  };

  return { client, requests };
}

/** Comprueba que una ruta de dos pasos encadena la salida con la siguiente entrada. */
test('ArbitrageCalculator evaluates a two-step route', async () => {
  const route: ArbitrageRoute = {
    steps: [
      { inputMint: SOL, outputMint: USDC },
      { inputMint: USDC, outputMint: SOL },
    ],
  };
  const { client, requests } = createMockClient(['2000000000', '1100000000']);
  const calculator = new ArbitrageCalculator(client, 75);

  const result = await calculator.evaluateRoute(route, '1000000000');

  assert.equal(result.quotes.length, 2);
  assert.equal(result.inputAmount, '1000000000');
  assert.equal(result.finalAmount, '1100000000');
  assert.equal(requests[0].amount, 1000000000);
  assert.equal(requests[1].amount, 2000000000);
  assert.equal(requests[1].slippageBps, 75);
});

/** Comprueba que una ruta de tres pasos encadena correctamente las tres cotizaciones. */
test('ArbitrageCalculator evaluates a three-step route', async () => {
  const route: ArbitrageRoute = {
    steps: [
      { inputMint: SOL, outputMint: USDC },
      { inputMint: USDC, outputMint: USDT },
      { inputMint: USDT, outputMint: SOL },
    ],
  };
  const { client } = createMockClient(['2000000000', '1900000000', '1050000000']);
  const calculator = new ArbitrageCalculator(client);

  const result = await calculator.evaluateRoute(route, '1000000000');

  assert.equal(result.quotes.length, 3);
  assert.equal(result.finalAmount, '1050000000');
});

/** Comprueba que se rechazan rutas con una cantidad de pasos no permitida. */
test('ArbitrageCalculator rejects routes with an invalid step count', async () => {
  const { client } = createMockClient([]);
  const calculator = new ArbitrageCalculator(client);
  const route: ArbitrageRoute = {
    steps: [{ inputMint: SOL, outputMint: USDC }],
  };

  await assert.rejects(calculator.evaluateRoute(route, '1000000000'), /debe tener 2 o 3 pasos/);
});

/** Comprueba que se rechazan pasos cuyo mint de salida no conecta con el siguiente. */
test('ArbitrageCalculator rejects disconnected routes', async () => {
  const { client } = createMockClient([]);
  const calculator = new ArbitrageCalculator(client);
  const route: ArbitrageRoute = {
    steps: [
      { inputMint: SOL, outputMint: USDC },
      { inputMint: USDT, outputMint: SOL },
    ],
  };

  await assert.rejects(calculator.evaluateRoute(route, '1000000000'), /no están encadenados/);
});
