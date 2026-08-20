import test from 'node:test';
import assert from 'node:assert/strict';

import { RpcManager, type RpcConnection, type RpcEndpoint } from './rpcManager';

const endpoints: RpcEndpoint[] = [
  { name: 'Helius', url: 'https://helius.test' },
  { name: 'Triton', url: 'https://triton.test' },
  { name: 'QuickNode', url: 'https://quicknode.test' },
];

/** Crea una conexión RPC falsa que devuelve éxito o error controlado. */
function connection(result: string | Error): RpcConnection {
  return {
    getLatestBlockhash: async () => {
      if (result instanceof Error) {
        throw result;
      }

      return { blockhash: result, lastValidBlockHeight: 1 };
    },
  };
}

/** Comprueba el fallback automático de Helius a Triton. */
test('RpcManager falls back from Helius to Triton when an RPC request fails', async () => {
  const manager = new RpcManager({
    endpoints,
    connectionFactory: (endpoint) =>
      endpoint.name === 'Helius'
        ? connection(new Error('Helius unavailable'))
        : connection(endpoint.name),
  });

  const providerUsed = await manager.request(async (rpc) => {
    const result = await rpc.getLatestBlockhash();
    return result.blockhash;
  });

  assert.equal(providerUsed, 'Triton');
  assert.equal(manager.getActiveProvider(), 'Triton');
});

/** Comprueba el fallback automático hasta QuickNode. */
test('RpcManager uses QuickNode after Helius and Triton fail', async () => {
  const manager = new RpcManager({
    endpoints,
    connectionFactory: (endpoint) =>
      endpoint.name === 'QuickNode'
        ? connection('QuickNode')
        : connection(new Error(`${endpoint.name} unavailable`)),
  });

  const providerUsed = await manager.request(async (rpc) => {
    const result = await rpc.getLatestBlockhash();
    return result.blockhash;
  });

  assert.equal(providerUsed, 'QuickNode');
  assert.equal(manager.getActiveProvider(), 'QuickNode');
});

/** Comprueba que el health check rota tras un error del proveedor activo. */
test('RpcManager health check rotates to the next provider on error', async () => {
  const manager = new RpcManager({
    endpoints,
    connectionFactory: (endpoint) =>
      endpoint.name === 'Helius'
        ? connection(new Error('Helius unavailable'))
        : connection(endpoint.name),
    healthCheckTimeoutMs: 10,
  });

  assert.equal(await manager.healthCheck(), false);
  assert.equal(manager.getActiveProvider(), 'Triton');
  assert.equal(await manager.healthCheck(), true);
});
