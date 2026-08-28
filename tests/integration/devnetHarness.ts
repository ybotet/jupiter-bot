/**
 * Harness de integración con RPC de Solana devnet.
 *
 * Encapsula la creación de la `Connection` real, la resolución del endpoint
 * (variable de entorno o fallback público) y el flag de "skip" para pruebas
 * que requieren conectividad de red. Se generan siempre keypairs efímeros con
 * `Keypair.generate()`: en integración nunca se leen claves privadas de
 * variables de entorno, respetando la política de seguridad del proyecto.
 */

import type { TestContext } from 'node:test';

import { Connection, Keypair, clusterApiUrl } from '@solana/web3.js';

/** Nombre de la variable que habilita las pruebas contra devnet real. */
export const DEVNET_TESTS_ENV = 'RUN_DEVNET_TESTS';

/** Nombre de la variable que sobreescribe el endpoint RPC de integración. */
export const DEVNET_RPC_ENV = 'DEVNET_RPC_URL';

/** Endpoint público por defecto de Solana devnet. */
export const DEFAULT_DEVNET_RPC = clusterApiUrl('devnet');

/** Contexto compartido devuelto por el harness. */
export interface DevnetHarness {
  connection: Connection;
  payer: Keypair;
  endpoint: string;
}

/**
 * Marca los tests de integración como saltados cuando no está habilitado el
 * flag `RUN_DEVNET_TESTS=1`. Debe llamarse al inicio del `test()` para evitar
 * abrir sockets contra devnet en CI offline o en máquinas sin conectividad.
 */
export function skipIfDevnetDisabled(t: TestContext): boolean {
  if (process.env[DEVNET_TESTS_ENV] !== '1') {
    t.skip(
      `Prueba de devnet omitida: exporta ${DEVNET_TESTS_ENV}=1 para habilitarla`,
    );
    return true;
  }
  return false;
}

/**
 * Crea un contexto de devnet con `Connection` y `Keypair` efímero.
 * El endpoint se toma de `DEVNET_RPC_URL` (si está definido) o del cluster
 * público por defecto. Nunca se persiste la clave privada.
 */
export function createDevnetHarness(): DevnetHarness {
  const endpoint = process.env[DEVNET_RPC_ENV] ?? DEFAULT_DEVNET_RPC;
  const connection = new Connection(endpoint, {
    commitment: 'processed',
    // Se limita el timeout para que un devnet lento no bloquee la suite.
    confirmTransactionInitialTimeout: 15_000,
  });
  return {
    connection,
    payer: Keypair.generate(),
    endpoint,
  };
}
