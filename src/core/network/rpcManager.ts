import { Connection, type Commitment } from '@solana/web3.js';

export type RpcProviderName = 'Helius' | 'Triton' | 'QuickNode';

export interface RpcConnection {
  getLatestBlockhash(commitment?: Commitment): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
}

export interface RpcEndpoint {
  name: RpcProviderName;
  url: string;
  wsUrl?: string;
}

export type RpcConnectionFactory = (endpoint: RpcEndpoint) => RpcConnection;

export interface RpcManagerOptions {
  endpoints?: RpcEndpoint[];
  connectionFactory?: RpcConnectionFactory;
  healthCheckTimeoutMs?: number;
}

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 100;

/** Resuelve los endpoints RPC en el orden Helius, Triton y QuickNode. */
export function resolveRpcEndpoints(env: NodeJS.ProcessEnv = process.env): RpcEndpoint[] {
  const endpoints: RpcEndpoint[] = [
    {
      name: 'Helius',
      url: env.RPC_ENDPOINT ?? '',
      wsUrl: env.RPC_WS_ENDPOINT,
    },
    {
      name: 'Triton',
      url: env.TRITON_RPC_ENDPOINT ?? '',
      wsUrl: env.TRITON_RPC_WS_ENDPOINT,
    },
    {
      name: 'QuickNode',
      url: env.QUICKNODE_RPC_ENDPOINT ?? '',
      wsUrl: env.QUICKNODE_RPC_WS_ENDPOINT,
    },
  ];

  return endpoints.filter((endpoint) => endpoint.url.length > 0);
}

export class RpcManager {
  private readonly providers: Array<RpcEndpoint & { connection: RpcConnection }>;
  private readonly healthCheckTimeoutMs: number;
  private activeProviderIndex = 0;

  /** Crea las conexiones RPC y selecciona Helius como proveedor inicial. */
  constructor(options: RpcManagerOptions = {}) {
    const endpoints = options.endpoints ?? resolveRpcEndpoints();
    if (endpoints.length === 0) {
      throw new Error('At least one RPC endpoint must be configured');
    }

    const connectionFactory =
      options.connectionFactory ??
      ((endpoint: RpcEndpoint) =>
        new Connection(endpoint.url, {
          commitment: 'processed',
          wsEndpoint: endpoint.wsUrl,
        }));

    this.providers = endpoints.map((endpoint) => ({
      ...endpoint,
      connection: connectionFactory(endpoint),
    }));
    this.healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  }

  /** Devuelve el nombre del proveedor actualmente activo. */
  public getActiveProvider(): RpcProviderName {
    return this.providers[this.activeProviderIndex].name;
  }

  /** Devuelve la conexión del proveedor actualmente activo. */
  public getConnection(): RpcConnection {
    return this.providers[this.activeProviderIndex].connection;
  }

  /** Comprueba el proveedor activo y rota al siguiente si falla. */
  public async healthCheck(): Promise<boolean> {
    try {
      await this.withTimeout(
        this.getConnection().getLatestBlockhash('processed'),
        this.healthCheckTimeoutMs,
      );
      return true;
    } catch {
      this.advanceProvider();
      return false;
    }
  }

  /** Ejecuta una operación y prueba los proveedores siguientes ante un fallo. */
  public async request<T>(operation: (connection: RpcConnection) => Promise<T>): Promise<T> {
    const failedProviders: RpcProviderName[] = [];

    for (let attempt = 0; attempt < this.providers.length; attempt += 1) {
      const provider = this.providers[this.activeProviderIndex];

      try {
        return await operation(provider.connection);
      } catch (error) {
        failedProviders.push(provider.name);
        if (attempt < this.providers.length - 1) {
          this.advanceProvider();
        } else {
          throw new Error(`All RPC providers failed: ${failedProviders.join(' -> ')}`, {
            cause: error,
          });
        }
      }
    }

    throw new Error('RPC request could not be completed');
  }

  /** Avanza al siguiente proveedor en el orden configurado. */
  private advanceProvider(): void {
    this.activeProviderIndex = (this.activeProviderIndex + 1) % this.providers.length;
  }

  /** Aplica un límite de tiempo a una comprobación de salud RPC. */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('RPC health check timed out')), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
