import Decimal from 'decimal.js';

import { loadStrategyConfig, type StrategyConfig } from '../../config/strategyConfig';
import {
  ArbitrageCalculator,
  type ArbitrageRoute,
  type EvaluatedArbitrageRoute,
} from './arbitrageCalculator';
import { estimateNetProfit, type NetProfitResult } from './profitEstimator';

export interface RouteCalculator {
  evaluateRoutes(routes: ArbitrageRoute[], inputAmount: string): Promise<EvaluatedArbitrageRoute[]>;
}

export interface StrategyOpportunity {
  evaluation: EvaluatedArbitrageRoute;
  profit: NetProfitResult;
}

export type OpportunityExecutor = (opportunity: StrategyOpportunity) => Promise<void>;

export type OpportunityCostEstimator = (
  evaluation: EvaluatedArbitrageRoute,
) => Parameters<typeof estimateNetProfit>[0];

export interface StrategyOrchestratorOptions {
  routes: ArbitrageRoute[];
  inputAmount: string;
  calculator?: RouteCalculator;
  config?: StrategyConfig;
  intervalMs?: number;
  /** Convierte beneficio y costes reales a USDC antes de aplicar el umbral. */
  estimateCosts: OpportunityCostEstimator;
  execute?: OpportunityExecutor;
}

/** Coordina la detección periódica y activa la ejecución de oportunidades rentables. */
export class StrategyOrchestrator {
  private readonly routes: ArbitrageRoute[];
  private readonly inputAmount: string;
  private readonly calculator: RouteCalculator;
  private readonly config: StrategyConfig;
  private readonly intervalMs: number;
  private readonly estimateCosts: OpportunityCostEstimator;
  private readonly execute: OpportunityExecutor;
  private timer: NodeJS.Timeout | undefined;
  private cycleRunning = false;

  /** Crea el orquestador con rutas, umbrales y dependencias configurables. */
  constructor(options: StrategyOrchestratorOptions) {
    const config = options.config ?? loadStrategyConfig();

    this.routes = options.routes;
    this.inputAmount = options.inputAmount;
    this.calculator =
      options.calculator ?? new ArbitrageCalculator(undefined, config.maxSlippageBps);
    this.config = config;
    this.intervalMs = options.intervalMs ?? 200;
    this.estimateCosts = options.estimateCosts;
    this.execute = options.execute ?? (async () => undefined);
  }

  /** Inicia el ciclo de detección inmediatamente y después cada 200 ms por defecto. */
  public start(): void {
    if (this.timer !== undefined) {
      return;
    }

    void this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.intervalMs);
  }

  /** Detiene el ciclo periódico de detección sin cancelar el ciclo en curso. */
  public stop(): void {
    if (this.timer === undefined) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Ejecuta un ciclo de evaluación y dispara el handler de cada oportunidad válida. */
  public async runCycle(): Promise<StrategyOpportunity[]> {
    if (this.cycleRunning || this.routes.length === 0) {
      return [];
    }

    this.cycleRunning = true;

    try {
      const evaluations = await this.calculator.evaluateRoutes(this.routes, this.inputAmount);
      const opportunities = evaluations
        .map((evaluation) => this.createOpportunity(evaluation))
        .filter((opportunity): opportunity is StrategyOpportunity => opportunity !== undefined);

      await Promise.all(opportunities.map((opportunity) => this.execute(opportunity)));
      return opportunities;
    } finally {
      this.cycleRunning = false;
    }
  }

  /** Convierte una evaluación en oportunidad cuando supera el umbral de beneficio. */
  private createOpportunity(evaluation: EvaluatedArbitrageRoute): StrategyOpportunity | undefined {
    const costInput = this.estimateCosts(evaluation);
    const profit = estimateNetProfit(costInput);

    if (new Decimal(profit.netProfit).lessThan(this.config.minProfitUsdc)) {
      return undefined;
    }

    return { evaluation, profit };
  }
}
