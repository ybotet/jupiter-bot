export interface StrategyConfig {
  /** Beneficio neto mínimo requerido, expresado en USDC. */
  minProfitUsdc: string;
  /** Slippage máximo permitido, expresado en puntos básicos. */
  maxSlippageBps: number;
}

export const DEFAULT_MIN_PROFIT_USDC = '0.1';
export const DEFAULT_MAX_SLIPPAGE_BPS = 50;

/** Carga y valida los umbrales de seguridad desde variables de entorno. */
export function loadStrategyConfig(env: NodeJS.ProcessEnv = process.env): StrategyConfig {
  const minProfitUsdc = env.MIN_PROFIT_USDC ?? DEFAULT_MIN_PROFIT_USDC;
  const maxSlippageBps = parseSlippageBps(env.MAX_SLIPPAGE_BPS);

  validateMinProfit(minProfitUsdc);

  return {
    minProfitUsdc,
    maxSlippageBps,
  };
}

/** Convierte el slippage configurado a puntos básicos y aplica el valor por defecto. */
function parseSlippageBps(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_SLIPPAGE_BPS;
  }

  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 0 || parsedValue > 10_000) {
    throw new Error('MAX_SLIPPAGE_BPS debe ser un entero entre 0 y 10000');
  }

  return parsedValue;
}

/** Valida que el beneficio mínimo sea un importe decimal finito y no negativo. */
function validateMinProfit(value: string): void {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue < 0 || value.trim().length === 0) {
    throw new Error('MIN_PROFIT_USDC debe ser un importe decimal no negativo');
  }
}
