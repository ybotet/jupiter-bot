import { randomUUID } from 'node:crypto';

import Decimal from 'decimal.js';

import { loadStrategyConfig, type StrategyConfig } from '../../config/strategyConfig';
import {
  createSilentLogger,
  logTransactionEvent,
  withTransactionContext,
  type Logger,
} from '../../utils/logger';
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
  /** Identificador único de esta oportunidad, propagado a todos los logs derivados. */
  transactionId: string;
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
  /** Logger opcional; si no se inyecta se usa uno silencioso. */
  logger?: Logger;
  /** Generador de transactionId inyectable (por defecto `crypto.randomUUID`). */
  transactionIdFactory?: () => string;
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
  private readonly logger: Logger;
  private readonly transactionIdFactory: () => string;
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
    this.logger = options.logger ?? createSilentLogger();
    this.transactionIdFactory = options.transactionIdFactory ?? (() => randomUUID());
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

      await Promise.all(
        opportunities.map((opportunity) => this.executeWithLogging(opportunity)),
      );
      return opportunities;
    } finally {
      this.cycleRunning = false;
    }
  }

  /**
   * Ejecuta el handler externo dentro de una envoltura de logs por transacción.
   * Emite `started` antes del envío, `succeeded` con el `profit` real cuando
   * finaliza sin errores y `failed` con el error saneado cuando lanza.
   * En caso de fallo relanza el error para no ocultarlo al consumidor.
   */
  private async executeWithLogging(opportunity: StrategyOpportunity): Promise<void> {
    const scoped = withTransactionContext(this.logger, opportunity.transactionId, {
      route: describeRoute(opportunity.evaluation),
    });
    const start = Date.now();
    logTransactionEvent(scoped, {
      status: 'started',
      transactionId: opportunity.transactionId,
      expectedProfit: opportunity.profit.netProfit,
    });
    try {
      await this.execute(opportunity);
      logTransactionEvent(scoped, {
        status: 'succeeded',
        transactionId: opportunity.transactionId,
        profit: opportunity.profit.netProfit,
        durationMs: Date.now() - start,
      });
    } catch (error) {
      logTransactionEvent(scoped, {
        status: 'failed',
        transactionId: opportunity.transactionId,
        error,
        durationMs: Date.now() - start,
      });
      throw error;
    }
  }

  /** Convierte una evaluación en oportunidad cuando supera el umbral de beneficio. */
  private createOpportunity(evaluation: EvaluatedArbitrageRoute): StrategyOpportunity | undefined {
    const costInput = this.estimateCosts(evaluation);
    const profit = estimateNetProfit(costInput);

    if (new Decimal(profit.netProfit).lessThan(this.config.minProfitUsdc)) {
      return undefined;
    }

    return { evaluation, profit, transactionId: this.transactionIdFactory() };
  }
}

/**
 * Genera una descripción legible de la ruta evaluada uniendo los símbolos o
 * mints implicados. Se usa como campo `route` en los logs por transacción.
 */
function describeRoute(evaluation: EvaluatedArbitrageRoute): string {
  const route = evaluation.route as unknown as {
    label?: string;
    id?: string;
    steps?: Array<{ inputMint?: string; outputMint?: string }>;
    inputMint?: string;
    outputMint?: string;
  };
  if (route.label) {
    return route.label;
  }
  if (route.id) {
    return route.id;
  }
  if (Array.isArray(route.steps) && route.steps.length > 0) {
    const mints = [route.steps[0]?.inputMint, ...route.steps.map((step) => step.outputMint)]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (mints.length > 0) {
      return mints.join('->');
    }
  }
  if (route.inputMint && route.outputMint) {
    return `${route.inputMint}->${route.outputMint}`;
  }
  return 'unknown';
}
