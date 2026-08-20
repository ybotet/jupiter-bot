import Decimal from 'decimal.js';

export interface NetProfitInput {
  /** Ingreso bruto y costes expresados en la misma moneda de cotización. */
  grossRevenue: string;
  /** Comisiones acumuladas de Jupiter expresadas en la moneda de cotización. */
  jupiterFees: string;
  /** Tip de Jito expresado en la moneda de cotización. */
  jitoTip: string;
  /** Slippage estimado en puntos básicos; 50 equivale a 0.5 %. */
  slippageBps: number;
}

export interface NetProfitResult {
  grossRevenue: string;
  jupiterFees: string;
  jitoTip: string;
  slippageCost: string;
  netProfit: string;
}

/**
 * Calcula el beneficio neto descontando slippage, fees de Jupiter y tip de Jito.
 * Todos los valores monetarios deben usar la misma moneda y unidad.
 */
export function estimateNetProfit(input: NetProfitInput): NetProfitResult {
  const grossRevenue = new Decimal(input.grossRevenue);
  const jupiterFees = new Decimal(input.jupiterFees);
  const jitoTip = new Decimal(input.jitoTip);

  validateAmount(grossRevenue, 'grossRevenue', false);
  validateAmount(jupiterFees, 'jupiterFees', true);
  validateAmount(jitoTip, 'jitoTip', true);
  validateSlippage(input.slippageBps);

  const slippageCost = grossRevenue.mul(input.slippageBps).div(10_000);
  const netProfit = grossRevenue.sub(jupiterFees).sub(jitoTip).sub(slippageCost);

  return {
    grossRevenue: grossRevenue.toFixed(),
    jupiterFees: jupiterFees.toFixed(),
    jitoTip: jitoTip.toFixed(),
    slippageCost: slippageCost.toFixed(),
    netProfit: netProfit.toFixed(),
  };
}

/** Valida que un importe sea decimal, finito y no negativo cuando corresponde. */
function validateAmount(amount: Decimal, name: string, allowZero: boolean): void {
  if (!amount.isFinite() || (!allowZero && amount.isZero()) || amount.isNegative()) {
    throw new Error(`${name} debe ser un importe decimal válido y no negativo`);
  }
}

/** Valida que el slippage esté expresado en un rango válido de puntos básicos. */
function validateSlippage(slippageBps: number): void {
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error('slippageBps debe estar entre 0 y 10000');
  }
}
