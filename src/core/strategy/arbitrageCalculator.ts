import { createJupiterApiClient, type QuoteGetRequest, type QuoteResponse } from '@jup-ag/api';
import Decimal from 'decimal.js';

export interface ArbitrageStep {
  inputMint: string;
  outputMint: string;
}

export interface ArbitrageRoute {
  steps: ArbitrageStep[];
  /** Decimales del activo inicial y final del ciclo de arbitraje. */
  profitDecimals: number;
}

export interface JupiterRouteClient {
  quoteGet(request: QuoteGetRequest): Promise<QuoteResponse>;
}

export interface EvaluatedArbitrageRoute {
  route: ArbitrageRoute;
  quotes: QuoteResponse[];
  inputAmount: string;
  finalAmount: string;
  /** Beneficio bruto normalizado a unidades del activo inicial. */
  grossProfit: string;
}

/** Calcula cotizaciones encadenadas de Jupiter para rutas de arbitraje de 2 o 3 pasos. */
export class ArbitrageCalculator {
  private readonly client: JupiterRouteClient;
  private readonly slippageBps: number;

  /** Crea el calculador con el cliente Jupiter y el slippage configurado. */
  constructor(client: JupiterRouteClient = createJupiterApiClient(), slippageBps = 50) {
    this.client = client;
    this.slippageBps = slippageBps;
  }

  /** Evalúa una ruta y encadena la salida de cada cotización como entrada siguiente. */
  public async evaluateRoute(
    route: ArbitrageRoute,
    inputAmount: string,
  ): Promise<EvaluatedArbitrageRoute> {
    this.validateRoute(route);
    const normalizedInput = this.normalizeRawAmount(inputAmount);
    const quotes: QuoteResponse[] = [];
    let currentAmount = normalizedInput;

    for (const step of route.steps) {
      const quote = await this.client.quoteGet({
        inputMint: step.inputMint,
        outputMint: step.outputMint,
        amount: this.toSafeNumber(currentAmount),
        slippageBps: this.slippageBps,
        swapMode: 'ExactIn',
      });

      if (quote.inputMint !== step.inputMint || quote.outputMint !== step.outputMint) {
        throw new Error('Jupiter devolvió una cotización con mints incompatibles');
      }

      currentAmount = this.normalizeRawAmount(quote.outAmount);
      quotes.push(quote);
    }

    return {
      route,
      quotes,
      inputAmount: normalizedInput,
      finalAmount: currentAmount,
      grossProfit: this.toDecimalAmount(currentAmount, route.profitDecimals)
        .sub(this.toDecimalAmount(normalizedInput, route.profitDecimals))
        .toFixed(),
    };
  }

  /** Evalúa varias rutas y devuelve sus resultados en el mismo orden recibido. */
  public async evaluateRoutes(
    routes: ArbitrageRoute[],
    inputAmount: string,
  ): Promise<EvaluatedArbitrageRoute[]> {
    return Promise.all(routes.map((route) => this.evaluateRoute(route, inputAmount)));
  }

  /** Valida que la ruta represente exactamente dos o tres swaps encadenados. */
  private validateRoute(route: ArbitrageRoute): void {
    if (!Number.isInteger(route.profitDecimals) || route.profitDecimals < 0) {
      throw new Error('La ruta debe declarar decimales de beneficio válidos');
    }

    if (route.steps.length !== 2 && route.steps.length !== 3) {
      throw new Error('La ruta de arbitraje debe tener 2 o 3 pasos');
    }

    for (let index = 1; index < route.steps.length; index += 1) {
      const previousStep = route.steps[index - 1];
      const currentStep = route.steps[index];

      if (previousStep.outputMint !== currentStep.inputMint) {
        throw new Error('Los pasos de la ruta no están encadenados por sus mints');
      }
    }
  }

  /** Convierte un importe bruto a unidades decimales sin perder precisión. */
  private toDecimalAmount(amount: string, decimals: number): Decimal {
    return new Decimal(amount).div(new Decimal(10).pow(decimals));
  }

  /** Normaliza un importe bruto y evita valores negativos o no enteros. */
  private normalizeRawAmount(amount: string): string {
    if (!/^\d+$/.test(amount) || amount === '0') {
      throw new Error('El importe bruto debe ser un entero positivo');
    }

    return amount;
  }

  /** Convierte un importe bruto a number solo si cabe sin pérdida de precisión. */
  private toSafeNumber(amount: string): number {
    const numericAmount = Number(amount);

    if (!Number.isSafeInteger(numericAmount)) {
      throw new Error('El importe bruto excede la precisión segura de la API de Jupiter');
    }

    return numericAmount;
  }
}
