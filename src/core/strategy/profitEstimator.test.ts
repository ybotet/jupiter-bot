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
