import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateNetProfit } from './profitEstimator';

/** Comprueba que el cálculo descuenta cada coste del ingreso bruto. */
test('estimateNetProfit discounts fees, Jito tip, and slippage', () => {
  const result = estimateNetProfit({
    grossRevenue: '100',
    jupiterFees: '0.25',
    jitoTip: '0.10',
    slippageBps: 50,
  });

  assert.equal(result.slippageCost, '0.5');
  assert.equal(result.netProfit, '99.15');
});

/** Comprueba que el cálculo conserva precisión decimal en cantidades financieras. */
test('estimateNetProfit preserves decimal precision', () => {
  const result = estimateNetProfit({
    grossRevenue: '0.3',
    jupiterFees: '0.1',
    jitoTip: '0.1',
    slippageBps: 0,
  });

  assert.equal(result.netProfit, '0.1');
});

/** Comprueba que una combinación de costes puede producir beneficio negativo. */
test('estimateNetProfit returns a negative result when costs exceed revenue', () => {
  const result = estimateNetProfit({
    grossRevenue: '1',
    jupiterFees: '0.8',
    jitoTip: '0.3',
    slippageBps: 0,
  });

  assert.equal(result.netProfit, '-0.1');
});

/** Comprueba que un slippage extremo reduce completamente el ingreso bruto. */
test('estimateNetProfit handles maximum slippage', () => {
  const result = estimateNetProfit({
    grossRevenue: '100',
    jupiterFees: '0',
    jitoTip: '0',
    slippageBps: 10_000,
  });

  assert.equal(result.slippageCost, '100');
  assert.equal(result.netProfit, '0');
});

/** Comprueba que el estimador rechaza importes y slippage fuera de rango. */
test('estimateNetProfit rejects invalid financial inputs', () => {
  assert.throws(
    () =>
      estimateNetProfit({
        grossRevenue: '100',
        jupiterFees: '-0.1',
        jitoTip: '0',
        slippageBps: 50,
      }),
    /jupiterFees debe ser/,
  );

  assert.throws(
    () =>
      estimateNetProfit({
        grossRevenue: '100',
        jupiterFees: '0.1',
        jitoTip: '0',
        slippageBps: 10_001,
      }),
    /slippageBps debe estar/,
  );
});
