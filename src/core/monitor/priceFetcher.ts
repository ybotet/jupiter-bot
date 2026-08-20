import { createJupiterApiClient, type QuoteGetRequest, type QuoteResponse } from '@jup-ag/api';

import { PriceCache } from './priceCache';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export type MarketPair = 'SOL/USDC' | 'SOL/USDT';

export interface PriceSnapshot {
  pair: MarketPair;
  price: number;
  timestamp: number;
  dex: 'Jupiter';
  inputMint: string;
  outputMint: string;
  rawAmount: number;
  rawOutput: number;
}

export interface JupiterQuoteClient {
  quoteGet(request: QuoteGetRequest): Promise<QuoteResponse>;
}

export class PriceFetcher {
  private readonly client: JupiterQuoteClient;
  private readonly intervalMs: number;
  private readonly latestPrices = new Map<MarketPair, PriceSnapshot>();
  private readonly quoteCache = new PriceCache<PriceSnapshot>(200);
  private timer: NodeJS.Timeout | undefined;

  /** Crea un recuperador con intervalo de consulta y cliente Jupiter configurables. */
  constructor(intervalMs = 200, client: JupiterQuoteClient = createJupiterApiClient()) {
    this.intervalMs = intervalMs;
    this.client = client;
  }

  /** Inicia la consulta periódica de los dos pares monitorizados. */
  public start(): void {
    if (this.timer !== undefined) {
      return;
    }

    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
  }

  /** Detiene el temporizador activo de consulta, si existe. */
  public stop(): void {
    if (this.timer === undefined) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Obtiene y normaliza la última cotización de un par monitorizado. */
  public async fetchPrice(pair: MarketPair): Promise<PriceSnapshot> {
    const cached = this.quoteCache.get(pair);
    if (cached) {
      return cached;
    }

    const { inputMint, outputMint } = this.getPairConfig(pair);
    const inputAmount = 1_000_000_000;

    try {
      const quote = await this.client.quoteGet({
        inputMint,
        outputMint,
        amount: inputAmount,
        slippageBps: 50,
        swapMode: 'ExactIn',
      });

      const snapshot = this.toSnapshot(pair, quote, inputAmount);
      this.quoteCache.set(pair, snapshot);
      this.latestPrices.set(pair, snapshot);

      return snapshot;
    } catch {
      const fallback = this.latestPrices.get(pair) ?? this.createFallbackSnapshot(pair);
      const previousPrice = fallback.price > 0 ? fallback.price : 0;
      const cachedFallback: PriceSnapshot = {
        ...fallback,
        timestamp: Date.now(),
        price: previousPrice,
      };

      this.quoteCache.set(pair, cachedFallback);
      this.latestPrices.set(pair, cachedFallback);

      return cachedFallback;
    }
  }

  /** Obtiene SOL/USDC y SOL/USDT de forma concurrente. */
  public async fetchAll(): Promise<Record<MarketPair, PriceSnapshot>> {
    const [solUsdc, solUsdt] = await Promise.all([
      this.fetchPrice('SOL/USDC'),
      this.fetchPrice('SOL/USDT'),
    ]);

    return {
      'SOL/USDC': solUsdc,
      'SOL/USDT': solUsdt,
    };
  }

  /** Devuelve el último snapshot válido o de respaldo de cada par. */
  public getLatestPrices(): Record<MarketPair, PriceSnapshot> {
    return {
      'SOL/USDC': this.latestPrices.get('SOL/USDC') ?? this.createFallbackSnapshot('SOL/USDC'),
      'SOL/USDT': this.latestPrices.get('SOL/USDT') ?? this.createFallbackSnapshot('SOL/USDT'),
    };
  }

  /** Consulta ambos pares y actualiza el almacén sin romper el ciclo. */
  private async pollOnce(): Promise<void> {
    try {
      const entries = await this.fetchAll();

      for (const [pair, snapshot] of Object.entries(entries) as Array<
        [MarketPair, PriceSnapshot]
      >) {
        this.latestPrices.set(pair, snapshot);
      }
    } catch {
      const fallback = {
        'SOL/USDC': this.latestPrices.get('SOL/USDC') ?? this.createFallbackSnapshot('SOL/USDC'),
        'SOL/USDT': this.latestPrices.get('SOL/USDT') ?? this.createFallbackSnapshot('SOL/USDT'),
      };

      this.latestPrices.set('SOL/USDC', fallback['SOL/USDC']);
      this.latestPrices.set('SOL/USDT', fallback['SOL/USDT']);
    }
  }

  /** Crea un snapshot con precio cero cuando Jupiter no responde. */
  private createFallbackSnapshot(pair: MarketPair): PriceSnapshot {
    const { inputMint, outputMint } = this.getPairConfig(pair);

    return {
      pair,
      price: 0,
      timestamp: Date.now(),
      dex: 'Jupiter',
      inputMint,
      outputMint,
      rawAmount: 1_000_000_000,
      rawOutput: 0,
    };
  }

  /** Resuelve los mints asociados a un par de mercado compatible. */
  private getPairConfig(pair: MarketPair): { inputMint: string; outputMint: string } {
    switch (pair) {
      case 'SOL/USDC':
        return { inputMint: SOL_MINT, outputMint: USDC_MINT };
      case 'SOL/USDT':
        return { inputMint: SOL_MINT, outputMint: USDT_MINT };
      default:
        throw new Error(`Unsupported market pair: ${pair}`);
    }
  }

  /** Convierte cantidades brutas de Jupiter en un snapshot legible. */
  private toSnapshot(pair: MarketPair, quote: QuoteResponse, rawAmount: number): PriceSnapshot {
    const inputDecimals = 9;
    const outputDecimals = 6;
    const rawOutput = Number(quote.outAmount);
    const solAmount = rawAmount / 10 ** inputDecimals;
    const outputAmount = rawOutput / 10 ** outputDecimals;
    const price = solAmount === 0 ? 0 : outputAmount / solAmount;
    const { inputMint, outputMint } = this.getPairConfig(pair);

    return {
      pair,
      price,
      timestamp: Date.now(),
      dex: 'Jupiter',
      inputMint,
      outputMint,
      rawAmount,
      rawOutput,
    };
  }
}
