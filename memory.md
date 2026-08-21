## Memoria técnica

### Qué se hizo
- Módulo 1: monitor de precios Jupiter, caché TTL de 200 ms, `MempoolWatcher` y fallback RPC Helius → Triton → QuickNode.
- Módulo 2: evaluación de rutas Jupiter de 2 y 3 pasos, cálculo de beneficio neto y `StrategyOrchestrator` con umbral configurable.

### Por qué se hizo así
- Se separaron monitorización, estrategia y red según la arquitectura.
- Se usó `Decimal.js` para evitar errores de precisión financiera.
- Los costes deben llegar normalizados a USDC antes de activar una ejecución.
- Las dependencias se inyectan para facilitar pruebas sin llamadas reales ni secretos.

### Dónde están los cambios
- `src/core/monitor/`
- `src/core/network/rpcManager.ts`
- `src/core/strategy/`
- `src/config/strategyConfig.ts`
- `.env.example`

### Qué hemos aprendido
- Los importes brutos de tokens no pueden compararse directamente con umbrales en USDC.
- Jupiter puede aplicar rate limits, por lo que el monitor debe conservar valores anteriores y no detener el proceso.
- El tip de Jito está en lamports y requiere conversión antes de incluirlo en el beneficio neto.
- `logsSubscribe` con `processed` observa logs procesados, no un mempool completo de transacciones pendientes.
- La suite validada alcanza 26 pruebas pasando y el lint está correcto.

## Memoria técnica: Módulo 3

### Qué se hizo
- Se definieron las cuentas Anchor del ejecutor.
- Se implementó `execute_arbitrage` con dos CPI secuenciales para compra y venta.
- Se añadieron validaciones de autoridad, mints, saldo inicial, saldo final y costes.
- Se incorporaron errores personalizados para operaciones inválidas, slippage, overflow y arbitraje no rentable.
- Se creó un arnés de integración SPL en `tests/mev_executor.ts`.

### Por qué se hizo así
- La ejecución permanece en Rust/Anchor para garantizar atomicidad.
- Las CPI permiten delegar los swaps a programas externos sin incluir lógica de monitorización en el contrato.
- Las validaciones on-chain impiden continuar cuando el resultado no cubre gas, fees, tip de Jito o slippage.
- Las cuentas SPL reales evitan pruebas engañosas con claves públicas arbitrarias.

### Dónde están los cambios
- `programs/mev_executor/src/lib.rs`
- `programs/mev_executor/Cargo.toml`
- `tests/mev_executor.ts`
- `tsconfig.tests.json`
- `.eslintrc.cjs`
- `.gitignore`
- `package.json`

### Qué se aprendió
- `anchor test` requiere Anchor CLI y un validador local o devnet configurado.
- Las cuentas usadas en CPI deben existir, pertenecer al programa esperado y tener los signers correctos.
- `minimum_output_amount` y slippage deben validarse on-chain, no solo en TypeScript.
- Los costes deben sumarse con operaciones protegidas contra overflow.
- Las advertencias `unexpected cfg` proceden de macros de Anchor y no impiden la compilación.
- La integración real con Raydium, Orca o Meteora requiere programas desplegados y cuentas SPL financiadas en un entorno aislado.