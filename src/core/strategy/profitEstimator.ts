import Decimal from 'decimal.js';

export interface NetProfitInput {
  grossRevenue: string;
  jupiterFees: string;
  jitoTip: string;
  slippageBps: number;
}

export interface NetProfitResult {
  grossRevenue: string;
  jupiterFees: string;
  jitoTip: string;
  slippageCost: string;
  netProfit: string;
}

/** Calcula el beneficio neto descontando slippage, fees de Jupiter y tip de Jito. */
export function estimateNetProfit(input: NetProfitInput): NetProfitResult {
  const grossRevenue = new Decimal(input.grossRevenue);
  const jupiterFees = new Decimal(input.jupiterFees);
  const jitoTip = new Decimal(input.jitoTip);
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
