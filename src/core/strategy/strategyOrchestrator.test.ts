import test from 'node:test';
import assert from 'node:assert/strict';

import type { ArbitrageRoute, EvaluatedArbitrageRoute } from './arbitrageCalculator';
import { StrategyOrchestrator, type RouteCalculator } from './strategyOrchestrator';

const route: ArbitrageRoute = {
  profitDecimals: 3,
  steps: [
    { inputMint: 'SOL', outputMint: 'USDC' },
    { inputMint: 'USDC', outputMint: 'SOL' },
  ],
};

/** Crea una evaluación de ruta mínima para probar el umbral de rentabilidad. */
function createEvaluation(finalAmount: string): EvaluatedArbitrageRoute {
  return {
    route,
    quotes: [],
    inputAmount: '1000',
    finalAmount,
    grossProfit: String(Number(finalAmount) - 1000),
  };
}

/** Convierte la evaluación de prueba a costes expresados en USDC. */
function estimateCosts(evaluation: EvaluatedArbitrageRoute) {
  return {
    grossRevenue: evaluation.grossProfit,
    jupiterFees: '0',
    jitoTip: '0',
    slippageBps: 50,
  };
}

/** Crea un calculador falso que devuelve evaluaciones controladas sin llamar a Jupiter. */
function createCalculator(evaluations: EvaluatedArbitrageRoute[]): RouteCalculator {
  return {
    evaluateRoutes: async () => evaluations,
  };
}

/** Comprueba que solo se ejecutan oportunidades que superan el beneficio mínimo. */
test('StrategyOrchestrator executes opportunities above the configured threshold', async () => {
  const executed: string[] = [];
  const orchestrator = new StrategyOrchestrator({
    routes: [route],
    inputAmount: '1000',
    calculator: createCalculator([createEvaluation('1101')]),
    config: { minProfitUsdc: '0.5', maxSlippageBps: 50 },
    estimateCosts,
    execute: async (opportunity) => {
      executed.push(opportunity.profit.netProfit);
    },
  });

  const opportunities = await orchestrator.runCycle();

  assert.equal(opportunities.length, 1);
  assert.equal(executed.length, 1);
  assert.equal(executed[0], '100.495');
});

/** Comprueba que el orquestador descarta beneficios inferiores al umbral. */
test('StrategyOrchestrator skips opportunities below the configured threshold', async () => {
  let executions = 0;
  const orchestrator = new StrategyOrchestrator({
    routes: [route],
    inputAmount: '1000',
    calculator: createCalculator([createEvaluation('1001')]),
    config: { minProfitUsdc: '2', maxSlippageBps: 50 },
    estimateCosts,
    execute: async () => {
      executions += 1;
    },
  });

  const opportunities = await orchestrator.runCycle();

  assert.equal(opportunities.length, 0);
  assert.equal(executions, 0);
});

/** Comprueba que el umbral usa el beneficio neto tras fees, tip y slippage en USDC. */
test('StrategyOrchestrator applies USDC-denominated execution costs', async () => {
  const executed: string[] = [];
  const orchestrator = new StrategyOrchestrator({
    routes: [route],
    inputAmount: '1000',
    calculator: createCalculator([createEvaluation('1101')]),
    config: { minProfitUsdc: '0.9', maxSlippageBps: 50 },
    estimateCosts: () => ({
      grossRevenue: '1.25',
      jupiterFees: '0.2',
      jitoTip: '0.1',
      slippageBps: 50,
    }),
    execute: async (opportunity) => {
      executed.push(opportunity.profit.netProfit);
    },
  });

  const opportunities = await orchestrator.runCycle();

  assert.equal(opportunities.length, 1);
  assert.deepEqual(executed, ['0.94375']);
});

/** Comprueba que un ciclo en curso no se duplica por intervalos solapados. */
test('StrategyOrchestrator prevents overlapping detection cycles', async () => {
  let resolveEvaluation: (() => void) | undefined;
  const calculator: RouteCalculator = {
    evaluateRoutes: () =>
      new Promise((resolve) => {
        resolveEvaluation = () => resolve([createEvaluation('1101')]);
      }),
  };
  const orchestrator = new StrategyOrchestrator({
    routes: [route],
    inputAmount: '1000',
    calculator,
    config: { minProfitUsdc: '0.5', maxSlippageBps: 50 },
    estimateCosts,
  });

  const firstCycle = orchestrator.runCycle();
  const secondCycle = await orchestrator.runCycle();
  assert.equal(secondCycle.length, 0);

  resolveEvaluation?.();
  assert.equal((await firstCycle).length, 1);
});
