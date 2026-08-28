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

## Memoria técnica: Módulo 4.1

### Qué se hizo
- Se implementó `BundleBuilder` en `src/core/executor/bundleBuilder.ts` que construye y firma la instrucción Anchor `execute_arbitrage` con la compra y la venta secuenciadas dentro de una misma transacción atómica.
- Se añadió el IDL mínimo del programa (`MEV_EXECUTOR_IDL`) y los tipos compartidos (`ArbitrageBundleRequest`, `SwapInstructionData`, `ExecuteArbitrageAccounts`) en `src/contracts/anchor/mevExecutor.ts` para reutilizarlos entre off-chain y pruebas.
- Se codifican los argumentos con `BorshInstructionCoder` de `@coral-xyz/anchor` y las cuentas CPI adicionales se pasan como `remainingAccounts` sin duplicados.
- Las transacciones se compilan como `VersionedTransaction` (v0) con blockhash reciente y se firman con la `Keypair` inyectada o cargada desde `PRIVATE_KEY` (`.env`).
- Se cubrió el flujo con pruebas `node:test` que validan la firma, la secuenciación compra/venta, el rechazo de instrucciones de programas no autorizados, bundles vacíos y swaps inválidos.

### Por qué se hizo así
- El builder queda desacoplado del transporte a Jito (Tarea 4.2): sólo entrega un `SignedBundle` con transacciones firmadas y `lastValidBlockHeight` para que el ejecutor decida el envío.
- Se inyecta `connection`, `payer` y `programId` para poder probar sin llamadas RPC reales ni secretos, siguiendo el patrón usado en `RpcManager` y `StrategyOrchestrator`.
- Se valida el `programId` de cada instrucción antes de firmar para evitar bundles que contengan invocaciones no autorizadas.
- La carga de la clave privada sólo ocurre si no se inyecta un `Keypair`, y nunca se registra su valor.
- Se reutiliza el mismo blockhash para todas las transacciones del bundle, garantizando la misma ventana de expiración en el relay.

### Dónde están los cambios
- `src/core/executor/bundleBuilder.ts`
- `src/core/executor/bundleBuilder.test.ts`
- `src/contracts/anchor/mevExecutor.ts`

### Qué se aprendió
- El `BorshInstructionCoder` requiere que los nombres de los argumentos en camelCase coincidan con los del IDL (`buyInstruction`, `sellInstruction`), aunque en Rust estén en snake_case.
- Las cuentas CPI del swap deben propagarse como `remainingAccounts` para que el programa Anchor pueda resolver los `AccountInfo` durante `invoke`.
- Usar `VersionedTransaction` mantiene compatibilidad con Address Lookup Tables cuando la ruta de arbitraje involucre muchas cuentas.
- Ejecutar las pruebas compiladas con `node --test dist/**/*.test.js` es suficiente: no se necesita `ts-node` en esta fase.
- Toda la suite (31 pruebas) sigue pasando y el lint queda limpio tras la implementación.

## Memoria técnica: Módulo 4.2

### Qué se hizo
- Se implementó `JitoExecutor` en `src/core/executor/jitoExecutor.ts` que recibe un `SignedBundle`, lo envía al block-engine de Jito y confirma su inclusión en la cadena.
- Se aísla el transporte gRPC detrás de la interfaz `JitoRelayClient` (`sendBundle` + `onBundleResult`), con una factoría `createSearcherRelayClient(url, authKeypair)` que carga `jito-ts/dist/sdk/block-engine` con `import()` dinámico y construye un `bundle.Bundle` respetando el límite `JITO_MAX_TX_PER_BUNDLE = 5`.
- La confirmación es dual: sondeo `getSignatureStatuses` para inclusión on-chain más suscripción al stream de resultados del relay; se corta al superar `startBlockHeight + confirmationBlockWindow` o el `lastValidBlockHeight` del bundle.
- Los estados devueltos son `confirmed | accepted | rejected | timeout`, con `bundleId`, `signatures`, `slot`, `validatorIdentity` y `rejectionReason` según corresponda.
- Se añadieron pruebas `node:test` para: confirmación on-chain, rechazo del relay con motivo, timeout por ventana de bloques, bundle vacío, bundle con demasiadas transacciones y fallo on-chain de una firma.

### Por qué se hizo así
- Se define `JitoRelayClient` como interfaz mínima para poder probar sin gRPC ni keypair, siguiendo la inyección de dependencias ya usada en `RpcManager` y `BundleBuilder`.
- La factoría con `import()` dinámico evita cargar el runtime de gRPC durante las pruebas y mantiene el bundle build limpio para entornos donde `jito-ts` no esté disponible.
- La doble confirmación protege contra dos modos de fallo: (a) el relay acepta y luego el validador no incluye, (b) el validador confirma pero el evento del stream se retrasa.
- El tip de Jito y el `computeUnitPrice` dinámico quedan fuera de esta tarea (los cubre la 8.2) para mantener el módulo enfocado en el transporte.

### Dónde están los cambios
- `src/core/executor/jitoExecutor.ts`
- `src/core/executor/jitoExecutor.test.ts`
- `.env.example`

### Qué se aprendió
- `client.onBundleResult` de `jito-ts` entrega objetos con `accepted?` o `rejected?`, y el rechazo es una unión discriminada por clave (`stateAuctionBidRejected`, `simulationFailure`, etc.); recorrer las keys permite extraer un motivo legible sin acoplarse a un tipo generado.
- El `sendBundle` del searcher devuelve directamente un `bundleId` (uuid), no una promesa con envoltorio; los tests pueden simularlo con un simple `Promise.resolve(id)`.
- En el runner `node:test`, un `test(...)` sin su llave de cierre `});` provoca que los tests siguientes se registren como subtests del anterior y se marquen como `cancelledByParent`; verificar el cierre correcto de cada bloque evita falsos negativos.
- El paquete `jito-ts` expone tipos con propiedades enumeradas para `Rejected`, por lo que aceptar `rejected: unknown` en el mapper y validar en runtime es más robusto que tipar contra el generado.
- La suite completa alcanza 11 pruebas locales (5 de `bundleBuilder` + 6 de `jitoExecutor`) además de las pruebas Anchor externas, y `npm run lint` sigue en verde.

## Memoria técnica: Módulo 4.3

### Qué se hizo
- Se implementó `RetryHandler` en `src/core/executor/retryHandler.ts`, un orquestador que reintenta el envío del bundle hasta cinco veces cuando el estado no es `confirmed` o `accepted`, escalando el `computeUnitPrice` un 10 % entre intentos y aplicando backoff exponencial configurable.
- Se define la interfaz `BundleSubmitter` (`submit(bundle) => BundleSubmissionResult`) que implementa naturalmente `JitoExecutor`, y una `BundleFactory` que recibe el `computeUnitPrice` vigente para que el consumidor reconstruya el bundle con la instrucción `ComputeBudgetProgram.setComputeUnitPrice` cuando se integre la Tarea 8.2.
- El resultado agregado `RetryOutcome` conserva el historial completo (`RetryAttempt[]`) con el `computeUnitPrice`, estado, `bundleId`, motivo de rechazo o mensaje de error de cada intento, permitiendo auditar y alimentar el dashboard.
- Se validan las opciones (`maxAttempts > 0`, `computeUnitPriceMultiplier > 1`, backoff no negativo) y se inyecta una función `sleepFn` para poder omitir tiempos reales en las pruebas.
- Se añadieron seis pruebas `node:test` que cubren: éxito al primer intento, reintento tras `timeout`, agotamiento de intentos con `timeout` final, tolerancia a errores transitorios del submitter, propagación cuando todos los intentos fallan con excepción y validación de opciones inválidas.

### Por qué se hizo así
- El escalado del `computeUnitPrice` vive fuera del `JitoExecutor` para mantener el envío/confirmación como una capa determinista de una sola pasada; así el retry sólo necesita una `BundleFactory` que reconstruya y refirme el bundle con un `computeUnitPrice` mayor.
- La política de backoff exponencial con `sleepFn` inyectable respeta el patrón usado en el resto del proyecto (dependencias inyectables, sin llamadas reales en pruebas) y evita tests lentos o flakey.
- Los estados `confirmed` y `accepted` cortan inmediatamente el ciclo para no gastar más `computeUnitPrice` cuando el relay o la cadena ya asumieron el bundle; los estados `timeout` y `rejected` disparan reintento porque son recuperables con priorización mayor.
- Guardar la historia detallada facilita generar los logs estructurados (`pino`) exigidos por la arquitectura y sirve como base para alertas Telegram/Slack en Tarea 5.x sin acoplar el `RetryHandler` a un logger concreto.

### Dónde están los cambios
- `src/core/executor/retryHandler.ts`
- `src/core/executor/retryHandler.test.ts`
- `tasklist.md` (marcadores ✅ para Tareas 4.2 y 4.3)

### Qué se aprendió
- Un `test(...)` de `node:test` que pierde su llave de cierre `});` provoca que los siguientes tests se anidan como subtests y se cancelen con `cancelledByParent`; después del arreglo se recuperaron los seis casos de retry sin flakes.
- Reutilizar la interfaz `BundleSubmitter` en lugar de importar `JitoExecutor` completo mantiene el módulo probado sin arrastrar dependencias de `jito-ts` en la suite unitaria.
- Escalar el precio con `Math.ceil` sobre el multiplicador flotante garantiza que cada reintento use al menos un `microLamport` más que el anterior, incluso cuando el multiplicador da valores fraccionarios (por ejemplo 1000 → 1100 → 1210).
- La suite local sube a 17 pruebas (5 `bundleBuilder` + 6 `jitoExecutor` + 6 `retryHandler`) y `tsc` con `strict` sigue sin errores.

## Memoria técnica: Módulo 4.4

### Qué se hizo
- Se creó `src/utils/secrets.ts` como punto único de carga y saneamiento de secretos: exporta `loadKeypair`, `loadKeypairFromEnv`, `EnvSecretsProvider`, `SecretsProvider`, `redactSecret`, `redactSensitiveFields`, `isSensitiveFieldName`, `loadEnv` y las constantes `PRIVATE_KEY_ENV` / `REDACTED_PLACEHOLDER`.
- `loadKeypair` acepta claves en base58 y en formato JSON array (compatible con `solana-keygen`), valida entradas vacías y **nunca incluye el valor del secreto en el mensaje de error** cuando el formato es inválido.
- `EnvSecretsProvider` normaliza espacios y trata cadenas vacías como ausentes; `loadEnv` invoca `dotenv.config()` una única vez por proceso (idempotente).
- `redactSensitiveFields` recorre objetos y arrays de forma recursiva, reemplaza valores cuyo nombre de campo contenga palabras clave sensibles (`privateKey`, `secret`, `apiKey`, `password`, `authorization`, `mnemonic`, `seed`, `token`, …) por `***REDACTED***`, sin mutar la entrada y tolerando referencias circulares mediante un `WeakSet`.
- Se refactorizó `BundleBuilder` para consumir `loadKeypair` y `loadKeypairFromEnv` desde el módulo compartido, eliminando la duplicación local con `bs58.decode` que existía antes.
- Se añadieron once pruebas `node:test` que cubren: carga base58, carga JSON array, ausencia de la variable, cadena vacía, no filtración de la clave en errores, uso de un `SecretsProvider` inyectado, error por variable faltante en el provider, normalización de `process.env`, `redactSecret` con distintos inputs, detección de campos sensibles y saneamiento profundo con referencias circulares.
- Se actualizó `.env.example` con las notas sobre formato de `PRIVATE_KEY` y la referencia a `src/utils/secrets.ts`.

### Por qué se hizo así
- La arquitectura exige un **Secrets Manager** independiente del transporte y del builder; extraer la carga a `src/utils/secrets.ts` cumple esa separación y prepara el terreno para AWS Secrets Manager (basta con implementar otro `SecretsProvider`).
- El error de formato inválido no incluye el valor de la clave para evitar cualquier filtración accidental cuando `pino` u otro logger imprima la excepción.
- La redacción por nombre de campo es defensiva: colapsa todo el subárbol si el padre coincide, lo que evita fugas por serialización de estructuras que envuelvan un secreto en un objeto más complejo.
- Se mantiene el patrón de inyección de dependencias (`SecretsProvider` con implementación por defecto) igual que `RpcManager`, `BundleBuilder`, `JitoExecutor` y `RetryHandler`, permitiendo probar sin tocar `process.env`.
- No se introdujo `pino` en este módulo para no acoplarlo a un logger concreto; el saneamiento se expone como función pura que cualquier `pino.transport` o serializer puede aplicar.

### Dónde están los cambios
- `src/utils/secrets.ts`
- `src/utils/secrets.test.ts`
- `src/core/executor/bundleBuilder.ts` (elimina el `loadKeypair` local y consume el módulo compartido)
- `.env.example`
- `tasklist.md` (marcador ✅ para Tarea 4.4)

### Qué se aprendió
- Un nombre de campo con un fragmento sensible (`tokens`, `secretKey`, `authorization`) hace que `redactSensitiveFields` colapse todo el subárbol; los tests deben usar nombres neutros (`entries`) cuando el objetivo es verificar la propagación al interior del contenedor.
- Reutilizar `bs58.decode` y `JSON.parse` en un único módulo evita divergencias sutiles en el manejo de errores (por ejemplo, el `catch` unificado impide dejar escapar `SyntaxError` con fragmentos del JSON original).
- `dotenv.config()` es seguro invocarlo múltiples veces, pero envolverlo en una guarda evita logs de aviso duplicados en pipelines que arranquen varios entrypoints.
- La suite local llega a 28 pruebas (5 `bundleBuilder` + 6 `jitoExecutor` + 6 `retryHandler` + 11 `secrets`) y `tsc --strict` sigue sin errores.



