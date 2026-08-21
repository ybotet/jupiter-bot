import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_SLIPPAGE_BPS,
  DEFAULT_MIN_PROFIT_USDC,
  loadStrategyConfig,
} from './strategyConfig';

/** Comprueba que la configuración usa los umbrales de seguridad por defecto. */
test('loadStrategyConfig uses secure defaults', () => {
  const config = loadStrategyConfig({});

  assert.equal(config.minProfitUsdc, DEFAULT_MIN_PROFIT_USDC);
  assert.equal(config.maxSlippageBps, DEFAULT_MAX_SLIPPAGE_BPS);
});

/** Comprueba que la configuración acepta umbrales definidos por el entorno. */
test('loadStrategyConfig reads custom environment thresholds', () => {
  const config = loadStrategyConfig({
    MIN_PROFIT_USDC: '0.25',
    MAX_SLIPPAGE_BPS: '75',
  });

  assert.equal(config.minProfitUsdc, '0.25');
  assert.equal(config.maxSlippageBps, 75);
});

/** Comprueba que la configuración rechaza valores de seguridad inválidos. */
test('loadStrategyConfig rejects invalid thresholds', () => {
  assert.throws(() => loadStrategyConfig({ MIN_PROFIT_USDC: '-0.1' }), /MIN_PROFIT_USDC debe ser/);
  assert.throws(
    () => loadStrategyConfig({ MAX_SLIPPAGE_BPS: '50.5' }),
    /MAX_SLIPPAGE_BPS debe ser/,
  );
});
