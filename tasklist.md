# Plan de Implementación: Bot de Arbitraje MEV en Solana

Este plan desglosa la construcción del bot en **10 módulos secuenciales**, priorizando la entrega de valor temprana y la validación continua. Cada módulo contiene tareas atómicas (máximo 2 archivos) con criterios de aceptación técnicos.

---

## Módulo 0: Configuración de Entorno y Base del Proyecto
*(Duración estimada: 1 día)*

**Objetivo:** Establecer la base de código, dependencias y herramientas de desarrollo para ambos lenguajes (TypeScript y Rust).

| ID  | Tarea                                                                                                                         | Archivos Involucrados                         | Criterio de Aceptación                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| 0.1 | Inicializar proyecto Node.js/TypeScript y configurar `tsconfig.json` con `"strict": true`.                                    | `package.json`, `tsconfig.json`               | `npm run build` compila sin errores.                    |
| 0.2 | Instalar dependencias base: `@solana/web3.js`, `@coral-xyz/anchor`, `jito-ts`, `@jup-ag/api`, `decimal.js`, `dotenv`, `pino`. | `package.json`                                | Todas las dependencias listadas en `package.json`.      |
| 0.3 | Crear estructura de directorios: `src/core/`, `src/contracts/`, `src/utils/`, `tests/`.                                       | Estructura de carpetas                        | Los directorios existen y están vacíos.                 |
| 0.4 | Configurar entorno de desarrollo con Anchor (Rust) y solana CLI.                                                              | `Anchor.toml`, `Cargo.toml`                   | `anchor build` genera el programa sin errores.          |
| 0.5 | Crear archivo `.env.example` con variables: `RPC_ENDPOINT`, `PRIVATE_KEY`, `JITO_RELAY_URL`, `JUPITER_API_KEY`.               | `.env.example`                                | El archivo contiene todas las variables necesarias.     |
| 0.6 | Configurar linters y formateadores: ESLint + Prettier para TS, `rustfmt` para Rust.                                           | `.eslintrc.js`, `.prettierrc`, `rustfmt.toml` | `npm run lint` y `cargo fmt --check` pasan sin errores. |

---

## Módulo 1: Monitor de Mempool y Precios (Off-chain)
*(Duración estimada: 2 días)*

**Objetivo:** Implementar el módulo que consulta precios en tiempo real desde Jupiter y detecta oportunidades de arbitraje.

| ID  | Tarea                                                                                                                   | Archivos Involucrados                | Criterio de Aceptación                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| 1.1 | Crear `PriceFetcher` que obtenga precios de Jupiter (REST) cada 200ms para pares SOL/USDC y SOL/USDT.                   | `src/core/monitor/priceFetcher.ts`   | Devuelve objetos con `{price, timestamp, dex}` en < 150ms.                 |
| 1.2 | Implementar caché en memoria con TTL de 200ms para evitar llamadas redundantes.                                         | `src/core/monitor/priceCache.ts`     | La misma llamada en < 200ms retorna desde caché.                           |
| 1.3 | Crear `MempoolWatcher` que se suscriba a transacciones pendientes via WebSocket (Helius) y filtre por programas de DEX. | `src/core/monitor/mempoolWatcher.ts` | Recibe eventos de transacciones en tiempo real y las filtra correctamente. |
| 1.4 | Integrar gestión de RPCs con fallback automático (Helius -> Triton -> QuickNode).                                       | `src/core/network/rpcManager.ts`     | Si el RPC primario falla, cambia al secundario en < 100ms.                 |
| 1.5 | Escribir pruebas unitarias para el `PriceFetcher` con mocks de Jupiter API.                                             | `tests/priceFetcher.test.ts`         | Cobertura de pruebas > 80% en el módulo.                                   |

---

## Módulo 2: Motor de Cálculo de Beneficios (Off-chain)
*(Duración estimada: 2 días)*

**Objetivo:** Calcular rutas de arbitraje y beneficio neto, incluyendo fees y slippage.

| ID  | Tarea                                                                                                                   | Archivos Involucrados                       | Criterio de Aceptación                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| 2.1 | Crear `ArbitrageCalculator` que evalúe rutas de 2 y 3 pasos usando `Jupiter` SDK.                                       | `src/core/strategy/arbitrageCalculator.ts`  | Retorna rutas con beneficio estimado y las instrucciones necesarias.           |
| 2.2 | Implementar cálculo de beneficio neto restando: fees de Jupiter, Jito tip y slippage (configurable).                    | `src/core/strategy/profitEstimator.ts`      | El cálculo es preciso usando `Decimal.js` (sin errores de precisión).          |
| 2.3 | Definir umbrales de seguridad: beneficio mínimo (ej. 0.1 USDC) y slippage máximo (0.5%).                                | `src/config/strategyConfig.ts`              | Los valores se leen desde variables de entorno o archivo de configuración.     |
| 2.4 | Crear `StrategyOrchestrator` que ejecute el ciclo de detección cada 200ms y active la ejecución si se cumple el umbral. | `src/core/strategy/strategyOrchestrator.ts` | El ciclo se ejecuta continuamente y solo dispara cuando el beneficio > umbral. |
| 2.5 | Escribir pruebas unitarias para el cálculo de beneficio con datos de ejemplo.                                           | `tests/profitEstimator.test.ts`             | Validación de casos: beneficio positivo, negativo y con slippage extremo.      |

---

## Módulo 3: Contrato Anchor (On-chain)
*(Duración estimada: 2 días)*

**Objetivo:** Desarrollar el smart contract en Rust que ejecuta swaps atómicos con validación de beneficio.

| ID  | Tarea                                                                                                          | Archivos Involucrados                               | Criterio de Aceptación                                       |
| --- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| 3.1 | Definir estructura de cuentas y datos del contrato Anchor.                                                     | `contracts/anchor/programs/mev_executor/src/lib.rs` | El programa compila con `anchor build`.                      |
| 3.2 | Implementar función `execute_arbitrage` que recibe instrucciones de swap (compra y venta).                     | `contracts/anchor/programs/mev_executor/src/lib.rs` | La función ejecuta los swaps vía CPI a Raydium/Orca/Meteora. |
| 3.3 | Agregar validación de saldos: verificar que `saldo_final > saldo_inicial + gas_estimado`.                      | `contracts/anchor/programs/mev_executor/src/lib.rs` | La transacción revierte si la validación falla.              |
| 3.4 | Implementar manejo de errores personalizados (ej. `ArbitrageNotProfitable`) para revertir con mensajes claros. | `contracts/anchor/programs/mev_executor/src/lib.rs` | Los errores se capturan y registran en off-chain.            |
| 3.5 | Escribir pruebas de integración con Anchor (simulando swaps en devnet).                                        | `contracts/anchor/tests/mev_executor.ts`            | Todas las pruebas pasan en devnet con cuentas mock.          |

---

## Módulo 4: Orquestador y Ejecución con Jito (Off-chain)
*(Duración estimada: 2 días)*

**Objetivo:** Construir y enviar Jito Bundles para ejecutar el arbitraje atómicamente.

| ID  | Tarea                                                                                                              | Archivos Involucrados                | Criterio de Aceptación                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------ |
| 4.1 | Crear `BundleBuilder` que construya instrucciones firmadas para el contrato Anchor.                                | `src/core/executor/bundleBuilder.ts` | Genera un bundle con las instrucciones de compra y venta correctamente secuenciadas. |
| 4.2 | Integrar `Jito` SDK para enviar bundles al relay y manejar confirmaciones.                                         | `src/core/executor/jitoExecutor.ts`  | Envía bundles y recibe confirmación en < 3 bloques.                                  |
| 4.3 | Implementar lógica de reintentos: si el bundle no se confirma en 3 bloques, reenviar con mayor `computeUnitPrice`. | `src/core/executor/retryHandler.ts`  | Reintenta hasta 5 veces con backoff exponencial.                                     |
| 4.4 | Gestionar claves privadas: cargar desde `.env` y firmar sin exponer en logs.                                       | `src/utils/secrets.ts`               | Las claves nunca aparecen en logs o mensajes de error.                               |
| 4.5 | Escribir pruebas de integración con un RPC de devnet y Jito simulado.                                              | `tests/jitoExecutor.test.ts`         | Simula el envío y confirmación de un bundle exitoso.                                 |

---

## Módulo 5: Sistema de Logs, Alertas y Monitoreo
*(Duración estimada: 1 día)*

**Objetivo:** Implementar logging estructurado y alertas en tiempo real para supervisión.

| ID  | Tarea                                                                                                                 | Archivos Involucrados                                | Criterio de Aceptación                                           |
| --- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| 5.1 | Configurar logger con `pino` y salida a archivo rotativo (JSON).                                                      | `src/utils/logger.ts`                                | Los logs se escriben en formato JSON con timestamp y nivel.      |
| 5.2 | Enviar logs a Elasticsearch (o archivo local) con el contexto de cada transacción.                                    | `src/utils/logger.ts`                                | Los logs incluyen `transactionId`, `profit`, `error` si falla.   |
| 5.3 | Crear sistema de alertas: notificar a Telegram/Slack cuando: oportunidad perdida, transacción fallida, error crítico. | `src/utils/alertManager.ts`                          | Se recibe notificación en el canal configurado.                  |
| 5.4 | Escribir pruebas unitarias para el logger y el sistema de alertas (mocks).                                            | `tests/logger.test.ts`, `tests/alertManager.test.ts` | Las pruebas validan la estructura del log y el envío de alertas. |

---

## Módulo 6: Dashboard Web (Frontend)
*(Duración estimada: 2 días)*

**Objetivo:** Desarrollar una interfaz web para visualizar oportunidades y estado del bot.

| ID  | Tarea                                                                                                | Archivos Involucrados                    | Criterio de Aceptación                                                 |
| --- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| 6.1 | Crear servidor HTTP con Express que sirva el frontend (React) y una API REST para el estado del bot. | `src/api/server.ts`, `src/api/routes.ts` | El servidor responde con el estado del bot en `GET /status`.           |
| 6.2 | Construir frontend en React con componentes: tablero de oportunidades, historial, configuración.     | `public/index.html`, `src/web/app.tsx`   | La interfaz muestra datos en tiempo real (usando WebSocket o polling). |
| 6.3 | Integrar gráficos (Chart.js) para visualizar ganancias diarias y oportunidades detectadas.           | `src/web/components/Charts.tsx`          | Los gráficos se actualizan con datos históricos.                       |
| 6.4 | Conectar el frontend con la API del backend para mostrar oportunidades en tiempo real.               | `src/web/api/client.ts`                  | El tablero se actualiza automáticamente al detectar una oportunidad.   |

---

## Módulo 7: Integración y Pruebas End-to-End
*(Duración estimada: 2 días)*

**Objetivo:** Validar el flujo completo desde la detección hasta la ejecución en un entorno controlado (devnet/testnet).

| ID  | Tarea                                                                            | Archivos Involucrados          | Criterio de Aceptación                                        |
| --- | -------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| 7.1 | Desplegar el contrato Anchor en devnet y obtener el `programId`.                 | `contracts/anchor/Anchor.toml` | El programa está desplegado y se puede interactuar con él.    |
| 7.2 | Ejecutar una prueba end-to-end simulando una oportunidad de arbitraje en devnet. | `tests/e2e/arbitrage.e2e.ts`   | La transacción se confirma y el beneficio es positivo.        |
| 7.3 | Probar el sistema de reintentos y fallbacks con RPCs caídos (simulados).         | `tests/e2e/fallback.e2e.ts`    | El bot cambia de RPC y reintenta sin perder la oportunidad.   |
| 7.4 | Validar que los logs y alertas se generan correctamente durante la ejecución.    | `tests/e2e/logging.e2e.ts`     | Se registran eventos de éxito/fallo con el contexto adecuado. |

---

## Módulo 8: Optimización y Ajustes de Latencia
*(Duración estimada: 1 día)*

**Objetivo:** Reducir la latencia del sistema al máximo para competir en MEV.

| ID  | Tarea                                                                               | Archivos Involucrados                                              | Criterio de Aceptación                                               |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 8.1 | Medir y optimizar el tiempo de respuesta de `PriceFetcher` y `ArbitrageCalculator`. | `src/core/monitor/`, `src/core/strategy/`                          | Latencia promedio < 150ms en entorno de producción simulado.         |
| 8.2 | Configurar `computeUnitPrice` dinámico en Jito según la congestión de la red.       | `src/core/executor/jitoExecutor.ts`                                | El precio se ajusta automáticamente para mejorar la inclusión.       |
| 8.3 | Revisar y reducir el número de llamadas a RPCs innecesarias (caching eficiente).    | `src/core/network/rpcManager.ts`, `src/core/monitor/priceCache.ts` | Se reduce en un 30% el número de llamadas a RPCs.                    |
| 8.4 | Realizar pruebas de carga para verificar el comportamiento bajo alta demanda.       | `tests/performance/loadTest.ts`                                    | El bot maneja al menos 50 oportunidades por segundo sin degradación. |

---

## Módulo 9: Documentación, Seguridad y Despliegue
*(Duración estimada: 1 día)*

**Objetivo:** Preparar el proyecto para producción con documentación y medidas de seguridad.

| ID  | Tarea                                                                                         | Archivos Involucrados                         | Criterio de Aceptación                                                             |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| 9.1 | Escribir `README.md` con instrucciones de instalación, configuración y ejecución.             | `README.md`                                   | Un desarrollador puede configurar el proyecto siguiendo el README en < 10 minutos. |
| 9.2 | Crear `CHANGELOG.md` y actualizar `AGENT.md` y `ARCHITECTURE.md` con cambios finales.         | `CHANGELOG.md`, `AGENT.md`, `ARCHITECTURE.md` | Los documentos reflejan el estado actual del proyecto.                             |
| 9.3 | Configurar CI/CD con GitHub Actions para ejecutar pruebas y desplegar automáticamente en EC2. | `.github/workflows/ci.yml`                    | El pipeline corre pruebas y despliega en éxito.                                    |
| 9.4 | Revisar medidas de seguridad: rotación de claves, permisos de IAM, y encriptación de logs.    | `src/utils/secrets.ts`, `.env.example`        | Todas las claves están en variables de entorno; logs sin datos sensibles.          |
| 9.5 | Realizar un despliegue en mainnet con fondos de prueba (mínimos) y monitorear 24h.            | Infraestructura AWS (EC2)                     | El bot opera en mainnet con ganancias positivas (o sin pérdidas) durante 24h.      |

---

## ✅ Criterios de Aceptación Generales

- **Cobertura de pruebas:** > 80% en módulos críticos (`monitor`, `strategy`, `executor`).
- **Rendimiento:** Latencia de detección < 200ms; ejecución en < 3 bloques.
- **Seguridad:** Ninguna clave privada expuesta en logs o código.
- **Disponibilidad:** El bot se recupera automáticamente de fallos de RPC y Jito.
- **Documentación:** Todos los archivos de especificación (`AGENT.md`, `spec.md`, `ARCHITECTURE.md`) están actualizados y consistentes.

---

## 📌 Notas para el Equipo

- Cada tarea debe ser revisada mediante **Pull Request** y aprobada por al menos otro miembro del equipo.
- Las pruebas de integración y end-to-end deben ejecutarse en un entorno **aislado** (devnet) antes de tocar mainnet.
- Se recomienda usar **mocks** para servicios externos (Jupiter, Jito) en las pruebas unitarias.
- El módulo de ejecución (Jito) debe ser probado con **cuentas de prueba** que tengan fondos limitados para evitar pérdidas accidentales.