# Memoria técnica consolidada

Esta memoria agrupa las decisiones y aprendizajes de implementación por
módulo principal. Se omiten repeticiones entre tareas, pero se conservan los
detalles necesarios para continuar el desarrollo sin perder contexto.

## Módulo 1: Monitorización de precios, mempool y red

### Qué se hizo

- Se implementó `PriceFetcher` para consultar cotizaciones de Jupiter y
  normalizar snapshots de precios con `price`, `timestamp` y `dex`.
- Se añadió `priceCache.ts`, una caché en memoria con TTL de 200 ms para
  reducir llamadas redundantes y mantener el último valor válido.
- Se implementó `MempoolWatcher` sobre suscripciones WebSocket/RPC. Filtra
  logs por los programas DEX configurados para Raydium, Orca y Meteora.
- Se implementó `RpcManager` con proveedores primario, secundario y terciario
  (Helius, Triton y QuickNode), health checks, rotación y fallback automático.
- El monitor tolera errores de Jupiter y rate limits conservando snapshots
  anteriores para que el ciclo no se detenga.
- Se añadieron pruebas de normalización de cotizaciones, llamadas paralelas,
  caché, fallback ante error, polling, filtrado de logs y rotación de RPC.

### Por qué se hizo de esa forma

- La monitorización y toda la lógica de decisión viven en Node.js/TypeScript;
  Rust/Anchor se reserva exclusivamente para ejecución atómica on-chain.
- La caché reduce latencia y carga sobre Jupiter sin ocultar indefinidamente
  un dato obsoleto, ya que expira a los 200 ms.
- La inyección de dependencias permite probar el monitor con un cliente
  Jupiter y proveedores RPC simulados, sin red ni secretos reales.
- El failover evita que un endpoint degradado bloquee la detección. Los
  consumidores deben tratar los fallos de todos los proveedores como un
  estado recuperable y registrarlo para observabilidad.

### Dónde están los cambios

- `src/core/monitor/priceFetcher.ts`
- `src/core/monitor/priceCache.ts`
- `src/core/monitor/mempoolWatcher.ts`
- `src/core/network/rpcManager.ts`
- `src/config/strategyConfig.ts`
- `src/core/monitor/*.test.ts`
- `.env.example`

### Qué hemos aprendido

- `logsSubscribe` con compromiso `processed` observa logs ya procesados; no
  representa un mempool completo de transacciones pendientes.
- Los importes brutos de tokens no pueden compararse directamente con un
  umbral expresado en USDC. La normalización de unidad debe ocurrir antes de
  activar una ejecución.
- Jupiter puede aplicar rate limits; el monitor debe conservar el último
  snapshot válido y no finalizar el proceso ante un error aislado.
- Los tests deben comprobar tanto el fallback de datos como la rotación de
  endpoints y el cierre correcto del polling.

## Módulo 2: Estrategia, rutas y beneficio neto

### Qué se hizo

- Se implementó `ArbitrageCalculator` para evaluar rutas conectadas de dos y
  tres pasos usando datos de Jupiter.
- Se implementó `estimateNetProfit` con `Decimal.js`. La fórmula utilizada es:
  `netProfit = grossRevenue - jupiterFees - jitoTip - slippageCost`.
- El coste de slippage se calcula como `grossRevenue * slippageBps / 10000`.
- Se implementó `StrategyOrchestrator`, que ejecuta ciclos de detección,
  evita ciclos solapados y sólo solicita ejecución cuando se supera el umbral.
- Se configuraron umbrales de beneficio mínimo y slippage máximo desde
  variables de entorno mediante `strategyConfig.ts`.
- Las pruebas cubren rutas de dos y tres pasos, rutas desconectadas, límites,
  beneficios positivos y negativos, slippage extremo y precisión decimal.

### Por qué se hizo de esa forma

- `Decimal.js` evita errores de precisión que afectarían decisiones
  financieras; por ejemplo, `0.3 - 0.1 - 0.1` debe producir exactamente
  `0.1`, no `0.09999999999999998`.
- Todos los costes deben estar expresados en la misma moneda de cotización
  antes de calcular el resultado. El tip de Jito, inicialmente en lamports,
  requiere conversión a USDC antes de descontarse.
- La estrategia permanece desacoplada del transporte Jito mediante interfaces
  inyectables, lo que permite simular oportunidades sin firmar transacciones.
- El cálculo acepta beneficios negativos para que puedan registrarse y
  auditarse, pero el orquestador no los ejecuta si no superan el umbral.

### Dónde están los cambios

- `src/core/strategy/arbitrageCalculator.ts`
- `src/core/strategy/profitEstimator.ts`
- `src/core/strategy/strategyOrchestrator.ts`
- `src/core/strategy/*.test.ts`
- `src/config/strategyConfig.ts`

### Qué hemos aprendido

- El test base validado es `100 - 0.25 - 0.10 - 0.50 = 99.15`, con 50 bps
  de slippage.
- También se validan beneficio negativo cuando los costes superan el ingreso,
  slippage de 10 000 bps y rechazo de importes negativos o slippage fuera de
  `[0, 10000]`.
- Debe mantenerse un test end-to-end que cubra la conversión de tip desde
  lamports a USDC, porque el estimador recibe el coste ya normalizado.
- La validación financiera crítica no debe trasladarse a `number` ni quedar
  sólo en el frontend: debe existir tanto en TypeScript como en Anchor.

## Módulo 3: Contrato de ejecución Anchor

### Qué se hizo

- Se definieron las cuentas Anchor del ejecutor y se implementó
  `execute_arbitrage` con dos CPI secuenciales: swap de compra y swap de
  venta.
- Se validan autoridad, mints, cuentas token, saldos inicial y final,
  `minimum_output_amount`, slippage, costes y operaciones con overflow.
- El contrato revierte con errores personalizados cuando el arbitraje no es
  rentable o una condición de seguridad no se cumple.
- Se creó un arnés de integración SPL para probar cuentas y balances reales
  dentro de un entorno controlado.
- La integración está preparada para delegar swaps a Raydium, Orca y Meteora
  mediante CPI, sin incluir monitorización ni selección de rutas en Rust.

### Por qué se hizo de esa forma

- La ejecución on-chain debe ser atómica: si compra o venta falla, la
  transacción completa se revierte.
- La comprobación final exige que el saldo final sea mayor que el inicial más
  gas, fees, tip de Jito y slippage estimado. Esto proporciona defensa en
  profundidad frente a una desincronización del cálculo off-chain.
- Las CPI permiten reutilizar los programas DEX y mantener el contrato
  pequeño, verificable y separado del cerebro TypeScript.
- Las cuentas SPL reales evitan pruebas engañosas basadas únicamente en
  claves públicas arbitrarias.

### Dónde están los cambios

- `programs/mev_executor/src/lib.rs`
- `programs/mev_executor/Cargo.toml`
- `tests/mev_executor.ts`
- `Anchor.toml`
- `target/` se genera localmente y no forma parte del código fuente.

### Qué hemos aprendido

- Las cuentas usadas en CPI deben existir, pertenecer al programa esperado y
  llevar los signers correctos; una clave pública válida por sí sola no basta.
- `minimum_output_amount`, slippage y rentabilidad deben verificarse también
  on-chain, no sólo en el detector TypeScript.
- Los costes deben sumarse con operaciones protegidas contra overflow.
- `anchor test` requiere Anchor CLI y un validador local o devnet configurado.
- Las advertencias `unexpected cfg` procedentes de macros de Anchor no
  impiden necesariamente la compilación.
- La integración real con Raydium, Orca o Meteora necesita programas
  desplegados, cuentas SPL financiadas y un entorno aislado antes de mainnet.

## Módulo 4: Bundles Jito, reintentos y secretos

### Qué se hizo

- `BundleBuilder` construye la instrucción Anchor `execute_arbitrage`,
  secuencia compra y venta, propaga cuentas CPI como `remainingAccounts`,
  compila transacciones v0 y devuelve un `SignedBundle`.
- Se añadió `MEV_EXECUTOR_IDL` y tipos compartidos para solicitudes de bundle,
  datos de swap y cuentas Anchor.
- Se valida el `programId` antes de firmar, se rechazan bundles vacíos o
  inválidos y se reutiliza el mismo blockhash en las transacciones del bundle.
- `JitoExecutor` separa el transporte mediante `JitoRelayClient`, usa una
  factoría dinámica de `jito-ts`, respeta el máximo de cinco transacciones y
  confirma por estado on-chain y stream del relay.
- Los resultados normalizados son `confirmed`, `accepted`, `rejected` y
  `timeout`, con bundle id, firmas, slot, validador y motivo cuando existe.
- `RetryHandler` reintenta hasta cinco veces en estados recuperables, aplica
  backoff exponencial y escala el `computeUnitPrice` un 10 % por intento.
- `src/utils/secrets.ts` centraliza carga de claves base58 o JSON array,
  providers de secretos, carga idempotente de `.env` y redacción profunda de
  campos sensibles, incluyendo referencias circulares.
- Se añadieron simulador Jito en memoria, integración offline y pruebas
  devnet opt-in que nunca usan `PRIVATE_KEY` ni envían transacciones reales.

### Por qué se hizo de esa forma

- Builder, transporte y retry son capas independientes. Así el builder no
  conoce gRPC, el executor no reconstruye bundles y el retry puede solicitar
  una nueva firma con mayor prioridad.
- La confirmación dual cubre tanto un relay que acepta pero no incluye como
  una inclusión on-chain cuyo evento gRPC llega tarde.
- La clave privada se inyecta o se obtiene de variables de entorno; nunca se
  incluye en código, logs ni mensajes de error.
- La factoría dinámica evita cargar gRPC durante pruebas y mantiene el build
  utilizable cuando `jito-ts` no está disponible en un entorno unitario.
- La simulación con dobles permite verificar aceptación, rechazo, timeout,
  errores de stream y reintentos sin riesgo de fondos.

### Dónde están los cambios

- `src/core/executor/bundleBuilder.ts`
- `src/core/executor/jitoExecutor.ts`
- `src/core/executor/retryHandler.ts`
- `src/core/executor/*.test.ts`
- `src/contracts/anchor/mevExecutor.ts`
- `src/utils/secrets.ts`
- `src/utils/secrets.test.ts`
- `tests/integration/`
- `.env.example`

### Qué hemos aprendido

- `BorshInstructionCoder` exige nombres camelCase del IDL (`buyInstruction`,
  `sellInstruction`) aunque Rust use snake_case.
- Las cuentas CPI adicionales deben ir como `remainingAccounts` para que
  Anchor pueda resolver los `AccountInfo` durante `invoke`.
- Las transacciones v0 conservan compatibilidad con Address Lookup Tables
  cuando una ruta requiere muchas cuentas.
- En `node:test`, olvidar el cierre `});` de un test puede anidar los
  siguientes y producir falsos `cancelledByParent`.
- El `sendBundle` de searcher devuelve directamente un UUID; el simulador no
  debe envolverlo en una respuesta ficticia.
- Queda como hardening añadir `maxComputeUnitPrice` al retry y verificar en
  Tarea 8.2 que `ComputeBudgetProgram.setComputeUnitPrice` sea la primera
  instrucción del bundle final.

## Módulo 5: Logs, alertas y seguridad operacional

### Qué se hizo

- Se implementó `createLogger` con Pino, JSON estructurado, timestamp ISO,
  nivel textual, servicio, rotación por tiempo/tamaño mediante `pino-roll` y
  destino inyectable para pruebas.
- Se añadieron `withTransactionContext`, `logTransactionEvent` y
  `serializeError` para eventos `started`, `succeeded` y `failed`, incluyendo
  `transactionId`, beneficio, duración y error saneado.
- Se instrumentaron `StrategyOrchestrator`, `BundleBuilder`, `JitoExecutor` y
  `RetryHandler` con contexto y eventos de ciclo de vida.
- Se creó `AlertManager` con canales Telegram y Slack, filtro por severidad,
  timestamp, saneamiento de metadata, timeout configurable y tolerancia a
  fallos mediante `Promise.allSettled`.
- Las configuraciones de logger y alertas se leen desde `.env`; los tests
  usan `Writable`, fetch simulado, canales en memoria y providers inyectados.
- Se añadieron suites unitarias y de aceptación para formato, redacción,
  errores HTTP, niveles, contexto, canales y secretos.

### Por qué se hizo de esa forma

- `redactSensitiveFields` es la única fuente de verdad para logger, API y
  alertas. Esto evita que cada transporte tenga una lista distinta.
- El serializador de errores se registra explícitamente porque Pino aplica
  serializers antes de `formatters.log`; un `Error` sin serializar puede
  perder `message` y `stack` o filtrarse de forma inconsistente.
- `Promise.allSettled` garantiza que un Slack caído no impida entregar la
  alerta a Telegram ni bloquee la ruta caliente del bot.
- Los destinos se inyectan en pruebas para evitar threads de `pino-roll`, red
  externa y credenciales reales.
- Los errores de Telegram y Slack sólo exponen status y statusText; nunca
  token, URL de webhook, chat id ni `cause` sensible.

### Dónde están los cambios

- `src/utils/logger.ts`
- `src/utils/alertManager.ts`
- `src/utils/logger.test.ts`
- `src/utils/alertManager.test.ts`
- `tests/logger.test.ts`
- `tests/alertManager.test.ts`
- `.env.example`
- `package.json`
- `tasklist.md`

### Qué hemos aprendido

- La suite de aceptación debe permanecer separada de `test:unit`: los tests
  raíz de `tests/` se compilan con `tsconfig.tests.json` y los unitarios de
  `src/` con el pipeline principal.
- La suite local llegó a 103 pruebas unitarias, además de aceptación e
  integración offline; los conteos históricos menores corresponden a estados
  anteriores del repositorio.
- La integración de `AlertManager` con el runtime todavía corresponde al
  bootstrap del bot. También es recomendable sanear dentro de cada canal
  como defensa adicional para consumidores que los invoquen directamente.
- El uso de `globalThis.fetch` reduce dependencias; los tests deben inyectar
  un fetch compatible cuando se ejecuten en otro runtime.

## Módulo 6: Dashboard web y API

### Qué se hizo

- Se creó el servidor Express con `GET /status`, `GET /api/status`,
  `GET /api/health` y `GET /api/opportunities`.
- `InMemoryBotStatusProvider` mantiene estado y métricas con snapshots
  copiados para evitar mutaciones accidentales. `InMemoryOpportunityFeed`
  mantiene un buffer FIFO y soporta `since` y `limit` con máximo 100 entradas.
- El servidor añade `X-Request-Id`, logging de requests, 404 uniforme,
  fallback SPA opcional y saneamiento de respuestas y errores.
- Se creó el dashboard React con tablero de oportunidades, métricas,
  historial en `localStorage`, configuración editable y gráficos Chart.js.
- `src/web/api/client.ts` centraliza fetch tipado, URLs, `cache: no-store`,
  `AbortSignal`, errores HTTP y cliente configurable por `baseUrl`.
- `app.tsx` consulta estado y oportunidades en paralelo cada 2 segundos,
  permite mínimo configurable de 500 ms, usa cursor incremental `since`,
  deduplica oportunidades por `id`, conserva hasta 100 y filtra por slippage.
- Chart.js muestra evolución temporal de beneficio y oportunidades en ejes
  separados, además de ganancias diarias agregadas. Las instancias se
  actualizan sin animación y se destruyen al desmontar.
- El frontend se compila sin bundler mediante `tsconfig.web.json`, JSX
  moderno e import maps para React, React DOM y Chart.js.
- Se añadieron pruebas de rutas, estado, feed, ordenación, filtros, límites,
  saneamiento y servidor HTTP; la compilación web cubre la integración de
  tipos del cliente y la aplicación.

### Por qué se hizo de esa forma

- El cliente HTTP está separado de React para que la vista no conozca rutas
  Express ni detalles de transporte. Las respuestas usan cadenas para
  importes financieros y no pierden precisión por serialización.
- El polling satisface el requisito de tiempo real sin introducir WebSockets
  ni una nueva infraestructura en el backend. Las dos peticiones se ejecutan
  en paralelo para reducir latencia.
- El cursor incremental y la deduplicación evitan volver a descargar o
  mostrar repetidamente las mismas oportunidades.
- `localStorage` conserva historial y configuración sin introducir base de
  datos dentro del alcance del módulo.
- El frontend sólo convierte beneficio a `number` para coloreado o gráficos;
  no toma decisiones financieras críticas ni reemplaza `Decimal.js`.
- El build separado mantiene aislados los tipos DOM/JSX del backend Node y
  evita forzar bundlers o dependencias de servidor en el cliente.

### Dónde están los cambios

- `src/api/routes.ts`
- `src/api/server.ts`
- `src/api/index.ts`
- `src/api/routes.test.ts`
- `src/api/server.test.ts`
- `src/web/app.tsx`
- `src/web/api/client.ts`
- `src/web/components/Charts.tsx`
- `src/web/types/chart.d.ts`
- `public/index.html`
- `src/devDashboard.ts`
- `tsconfig.web.json`
- `package.json`, `.env.example`, `.gitignore`, `tasklist.md`

### Qué hemos aprendido

- `build:web`, `build` y `lint` son gates distintos: el primero valida DOM y
  JSX; los otros validan backend y código TypeScript del servidor.
- Un import map con CDN es suficiente para un dashboard interno sin SSR ni
  necesidad de bundler. El coste aceptado es depender del CDN al arrancar.
- Chart.js no quedó instalado como dependencia porque el registro npm sufrió
  `ECONNRESET`; se dejó un `.d.ts` ambiental mínimo. Puede sustituirse por
  `chart.js@4.4.6` cuando se quiera tipado completo.
- El historial está limitado a 50 snapshots y `localStorage` no sustituye un
  endpoint histórico si se necesita una vista mensual.
- La validación actual cubre API y compilación, pero queda como mejora una
  suite DOM específica para React y el cliente HTTP.
- El smoke test puede fallar con `EADDRINUSE` si `127.0.0.1:3001` ya está
  ocupado. Se debe liberar el proceso o usar otro `API_PORT`.

## Estado de verificación consolidado

- `npm run build`: correcto.
- `npm run build:web`: correcto.
- `npm run lint`: correcto.
- `npm run test:unit`: 103 pruebas correctas.
- `npm run test:acceptance`: correcto en la última ejecución validada.
- Las integraciones offline pasan; las pruebas devnet son opt-in y quedan
  omitidas salvo que `RUN_DEVNET_TESTS=1`.
- La lógica de Net Profit fue verificada con `Decimal.js`, incluyendo fees
  de Jupiter, tip de Jito, slippage, resultado negativo y precisión decimal.
- No se detectaron secretos versionados ni vulnerabilidades bloqueantes.

## Módulo 7: Integración y despliegue Devnet

### Qué se hizo

- Se desplegó `mev_executor` correctamente en Solana Devnet.
- El Program ID desplegado es `AtLhxzFGmy6HnzdRrpKHFReVvKWW2CqZWxGE2BEC23x3`.
- La cuenta IDL reportada por Anchor es `PGiPtxYDGRs4sbcSKTA5W9AKCGXRDgubX5zkxKM8D3V`.
- `solana program show` confirmó el owner `BPFLoaderUpgradeab1e11111111111111111111111`,
  `ProgramData Address` `4jhpba9h3w2MM3PqHSHL3a6La7fCcEZYkEnkwLf2Pi76`,
  slot de despliegue `495621085` y tamaño de programa `230032` bytes.
- La firma de despliegue `4AFXVBsbF8AgF44NyHQGu2BKJK6ALcLvUFN6Ch8m3VNbfX3CoHZ5PnQkHVtXuTkRVjeFtDf7ywAL2Q63RJbVFpm1` quedó `Finalized`.
- El entorno WSL dispone de Solana CLI `4.2.2`, Anchor CLI `0.32.1`, Cargo
  `1.98.1` y Node.js `v18.19.1`. `npm` no está instalado como comando Linux,
  pero Anchor puede invocar `node` directamente.
- Se alineó el Program ID en `Anchor.toml`, `programs/mev_executor/src/lib.rs`,
  `src/contracts/anchor/mevExecutor.ts` y `target/types/mev_executor.ts`.
- El proveedor Anchor quedó configurado para Devnet y el keypair de despliegue
  local está excluido de Git mediante `.gitignore`.

### Por qué se hizo de esa forma

- Mantener el mismo Program ID en Anchor, Rust, IDL y TypeScript evita firmar
  instrucciones contra una dirección distinta de la desplegada.
- Devnet permite validar el programa y preparar la integración end-to-end sin
  exponer fondos de mainnet.
- Las variables de endpoint y wallet se mantienen en `.env` o en la
  configuración local de Solana; ninguna clave privada se añade al código.

### Dónde están los cambios

- `Anchor.toml`
- `programs/mev_executor/src/lib.rs`
- `src/contracts/anchor/mevExecutor.ts`
- `target/types/mev_executor.ts`
- `ARCHITECTURE.md`
- `tasklist.md`
- `.env.example`
- `target/deploy/mev_executor-keypair.json` (local, ignorado por Git)

### Qué hemos aprendido

- La verificación definitiva del despliegue requiere `solana program show
  AtLhxzFGmy6HnzdRrpKHFReVvKWW2CqZWxGE2BEC23x3 --url devnet` y consultar la
  cuenta en Solana Explorer.
- `anchor test --provider.cluster devnet` necesita Anchor CLI, Solana CLI, una
  wallet configurada, Node.js y SOL suficiente en Devnet.
- Con Node.js disponible, Anchor compiló correctamente el programa y comenzó
  la suite, pero el intento de redeploy falló por `websocket error`, expiración
  de blockhash y error de conexión a `https://api.devnet.solana.com/`.
- El fallo de `anchor test` es de transporte/RPC durante el redeploy; no se
  observaron errores de compilación Rust ni errores funcionales de Anchor.
- La interacción de tests Devnet queda pendiente de repetir con un RPC estable
  o alternativo; el despliegue existente continúa verificado como `Finalized`.

### Tarea 7.3: Fallbacks RPC y reintentos

- Se añadió `tests/e2e/fallback.e2e.ts` con dobles inyectables: Helius falla,
  Triton responde y el `RetryHandler` obtiene `timeout` en el primer intento
  y `confirmed` en el segundo.
- La prueba valida que el bundle se reconstruye sin perder su transacción,
  que el `computeUnitPrice` sube de `1000` a `1500` y que el proveedor activo
  permanece en Triton para el reintento.
- El escenario es offline y no usa wallet, fondos ni RPC real; permite validar
  el comportamiento determinista de la arquitectura sin riesgo operativo.
- La compilación de `tsconfig.tests.json` y la prueba E2E pasan: `1 pass, 0 fail`.

### Tarea 7.4: Logs y alertas E2E

- Se añadió `tests/e2e/logging.e2e.ts` con logger y canal de alertas en memoria.
- La prueba verifica eventos `transaction:started`, `transaction:succeeded` y
  `transaction:failed`, todos con el mismo `transactionId`.
- También comprueba alertas de éxito y fallo, timestamps, metadata saneada y
  ausencia de secretos en las líneas JSON capturadas.
- El escenario no usa Telegram, Slack, RPC ni claves; valida el flujo completo
  de observabilidad de forma determinista y offline.
- No se debe marcar el despliegue como mainnet: el Program ID documentado aquí
  corresponde únicamente a Devnet.
- Durante la configuración se detectó que `.env` contenía credenciales reales;
  aunque el archivo no está versionado, cualquier clave privada o token que se
  exponga debe revocarse y rotarse inmediatamente.