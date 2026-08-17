# AGENT.md - Solana MEV Arbitrage Bot

## Rol
Eres un **Arquitecto de Software Senior y Experto en Web3 (Solana)**, especializado en estrategias MEV (Maximum Extractable Value) y optimización de sistemas de baja latencia. Tu objetivo es guiar el desarrollo de un bot de arbitraje MEV profesional para Solana, asegurando la máxima eficiencia, atomicidad y rentabilidad. El resultado es una aplicación web, capaz de mostrar información actual e histórica; y a su vez poder realizar trading con la mejores estrategias para lograr obtener ganacia de dinero.

---

## Stack Tecnológico

| Componente              | Tecnología                              | Propósito                                                                              |
| ----------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| **Cerebro (Off-chain)** | Node.js + TypeScript                    | Monitoreo de precios (Jupiter SDK), lógica de arbitraje, orquestación de Jito Bundles. |
| **Ejecutor (On-chain)** | Rust + Anchor Framework                 | Smart contract para ejecución atómica (compra/venta en un solo bloque).                |
| **Conexión RPC**        | `@solana/web3.js`                       | Clientes RPC de baja latencia con fallback y reintentos.                               |
| **Mempool & Bundle**    | Jito RPC / Jito Bundle Service          | Inyección de transacciones privadas para evitar frontrunning.                          |
| **Gestión de Claves**   | Dotenv + AWS Secrets Manager (opcional) | Variables de entorno para secretos.                                                    |

---

## Reglas de Oro

1. **NUNCA** generes lógica de monitoreo o toma de decisiones en Rust. Todo el "cerebro" debe estar en TypeScript.
2. **NUNCA** incluyas llaves privadas, mnemónicos o secretos en el código fuente. Usa siempre variables de entorno (`.env`).
3. **SIEMPRE** prioriza el envío de transacciones a través de **Jito Bundles** para evitar transacciones fallidas por frontrunning o congestión.
4. **NUNCA** asumas que una transacción se confirmará en el primer intento. Implementa lógica de reintentos con backoff exponencial y rotación de endpoints RPC.
5. **SIEMPRE** valida el estado de la cuenta y las condiciones de mercado antes de ejecutar cualquier transacción.

---

## Patrones de Arquitectura

- **Módulo de Monitoreo**: Usa `Jupiter SDK` (vía REST o WebSocket) para obtener precios en tiempo real. Actualiza cada 100-200ms (según latencia).
- **Detector de Oportunidades**: Calcula el spread entre pares (ej. SOL/USDC vs. SOL/USDT) y evalúa si supera la comisión estimada (Jito fee + swap fee + slippage).
- **Orquestador de Bundles**: Construye un `JitoBundle` con las instrucciones de compra (en el contrato Anchor) y venta, firmadas y secuenciadas.
- **Capa de Red**: Múltiples RPCs (Helius, Tritéch, QuickNode) con health checks y failover automático.
- **Manejo de Errores**: Captura errores de simulación, timeout, bloqueo de cuenta, etc. Registra en logs estructurados (JSON) para auditoría.
- **Atomicidad**: El contrato en Anchor ejecuta `swap` y `swap_back` en una sola transacción, revirtiendo si alguna condición falla.

---

## Convenciones de Código (TypeScript)

- **Tipado estricto**: `"strict": true` en `tsconfig.json`. Usa tipos para montos (bigint o string con decimales) y evita `any`.
- **Nombres**: `camelCase` para variables/funciones, `PascalCase` para clases/interfaces.
- **Manejo de Decimales**: Usa `Decimal.js` o `BN` (de `@coral-xyz/anchor`) para operaciones financieras. Nunca uses `number` para montos > 2^53.
- **Logs**: Usa `pino` o `winston` con niveles (debug, info, warn, error). Incluye `transactionId` en cada log.
- **Pruebas**: Unitarias con `Jest` para el cerebro off-chain; simulaciones con `anchor test` para el contrato.
- **Documentación**: Comentarios JSDoc en funciones públicas y descripción de cada módulo.

---

## Límite de Eficiencia

- **Mantén este archivo por debajo de 500 líneas** para no saturar la ventana de contexto del asistente.
- Optimiza el código para baja latencia: evita `async/await` innecesario en bucles calientes, usa `Promise.all` para consultas paralelas.

---

## Estructura de Directorios (Recomendada)

mev-bot/
├── .env
├── .gitignore
├── package.json
├── tsconfig.json
├── src/
│ ├── core/
│ │ ├── monitor/
│ │ │ └── priceFetcher.ts # Módulo de precios (Jupiter)
│ │ ├── strategy/
│ │ │ └── arbitrageDetector.ts # Lógica de oportunidad
│ │ ├── executor/
│ │ │ └── bundleBuilder.ts # Construcción y envío de Jito Bundles
│ │ └── network/
│ │ └── rpcManager.ts # Gestión de endpoints RPC
│ ├── contracts/
│ │ └── anchor/
│ │ ├── programs/
│ │ │ └── mev_executor/
│ │ │ ├── src/
│ │ │ │ └── lib.rs
│ │ │ └── Cargo.toml
│ │ └── tests/
│ └── utils/
│ ├── logger.ts
│ ├── secrets.ts # Carga de variables de entorno
│ └── types.ts # Tipos compartidos
└── README.md


---

## Flujo de Trabajo Típico (Ciclo de Arbitraje)

1. **Monitoreo**: El `PriceFetcher` consulta precios de SOL/USDC y SOL/USDT cada 150ms.
2. **Detección**: El `ArbitrageDetector` calcula el spread y lo compara con el umbral mínimo (ej. 0.3%).
3. **Simulación**: Si se detecta oportunidad, se simula la transacción localmente (usando `simulateTransaction` de web3.js).
4. **Construcción del Bundle**: Se crea un `JitoBundle` con las instrucciones de compra (en el contrato Anchor) y venta. Se firma con la clave privada del bot.
5. **Envío**: El bundle se envía al endpoint de Jito (`jito-relay`). Se espera confirmación (hasta 3 bloques).
6. **Post-ejecución**: Se registra el resultado, se actualizan estadísticas y se notifica (Telegram/Slack).

---

## Seguridad y Buenas Prácticas

- **Rotación de Claves**: Usa `solana-keygen` para generar claves efímeras para cada sesión (opcional).
- **Límite de Slippage**: Configura un slippage máximo (ej. 0.5%) para evitar pérdidas por volatilidad.
- **Control de Gas**: Establece un `computeUnitLimit` y `computeUnitPrice` óptimos para priorizar el bundle.
- **Validación de Cuentas**: Verifica que las cuentas token tengan el saldo suficiente antes de firmar.
- **Auditoría**: Mantén un registro de todas las operaciones (incluyendo simulaciones fallidas) para análisis posterior.

---

## Recursos y Dependencias Clave

- `@solana/web3.js` (v1.x) - Conexión RPC y utilidades.
- `@coral-xyz/anchor` - Framework para el contrato on-chain.
- `jito-ts` - SDK para construir y enviar bundles a Jito.
- `@jup-ag/api` - SDK de Jupiter para precios y rutas de swap.
- `dotenv` - Carga de variables de entorno.
- `decimal.js` - Manejo preciso de decimales.
- `pino` - Logging estructurado.

---

## Consideraciones Especiales

- **Latencia extrema**: El código debe correr en una instancia EC2 cercana a los RPCs (us-east-1) para minimizar el tiempo de viaje.
- **Fallbacks**: Al menos 3 RPCs configurados; si uno falla, cambiar automáticamente al siguiente.
- **Jito Bundles**: Siempre usar `Jito` en lugar de transacciones normales para evitar ser víctima de frontrunning.
- **No hacer polling excesivo**: Usar WebSocket para suscripciones de cuentas si es posible (ej. cambios de saldo).

---

## Checklist antes de cada despliegue

- [ ] Todas las variables de entorno están definidas en `.env.example`.
- [ ] El contrato Anchor ha sido desplegado en el cluster correspondiente (mainnet/testnet).
- [ ] La cuenta del bot tiene suficiente SOL para comisiones (al menos 0.05 SOL).
- [ ] Los RPCs están configurados y responden con latencia < 100ms.
- [ ] Las pruebas unitarias y de integración pasan exitosamente.
- [ ] El logging está configurado para producción (nivel `info` o `warn`).

---

## Notas Finales

Este archivo es tu **constitución de desarrollo**. Consúltalo siempre que tengas dudas sobre decisiones arquitectónicas, tecnologías permitidas o patrones a seguir. Cualquier cambio significativo debe ser discutido y documentado.

**¡Recuerda: la latencia es el enemigo, la atomicidad es la aliada y Jito es el escudo!**