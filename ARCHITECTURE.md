# ARCHITECTURE.md - Solana MEV Arbitrage Bot Infrastructure

## 🏛️ Visión General de Arquitectura

Este documento describe la infraestructura técnica del bot de arbitraje MEV para Solana, detallando la comunicación entre componentes, estrategias de baja latencia y la separación de responsabilidades entre el motor off-chain (Node.js/TypeScript) y el programa on-chain (Rust/Anchor).

---

## 📡 Diagrama de Arquitectura de Alto Nivel

```mermaid
flowchart TB
    subgraph "User Interface Layer"
        UI[Dashboard Web<br/>React + Chart.js]
    end

    subgraph "Off-Chain Engine (Node.js/TypeScript)"
        direction TB
        MON[Monitor Module<br/>Price Fetcher]
        DET[Detector Module<br/>Opportunity Calculator]
        ORC[Orchestrator Module<br/>Bundle Builder]
        LOG[Logger Module<br/>Pino + Elasticsearch]
        SEC[Secrets Manager<br/>AWS Secrets Manager]
    end

    subgraph "External Services"
        JUP[Jupiter SDK<br/>Price Quotes & Routes]
        RPC1[Primary RPC<br/>Helius]
        RPC2[Secondary RPC<br/>Triton]
        RPC3[Fallback RPC<br/>QuickNode]
        JITO[Jito Relay<br/>Bundle Endpoint]
        WS[WebSocket<br/>Mempool Monitoring]
    end

    subgraph "On-Chain Layer (Rust/Anchor)"
        CONTRACT[Arbitrage Executor<br/>Program ID: xxx]
        RAY[Raydium Pool]
        ORCA[Orca Pool]
        MET[Meteora Pool]
    end

    UI -->|REST API| ORC
    MON -->|HTTP| JUP
    MON -->|WebSocket| WS
    MON -->|RPC| RPC1
    MON -->|RPC (fallback)| RPC2
    MON -->|RPC (fallback)| RPC3
    DET -->|Read| MON
    ORC -->|Fetches routes| JUP
    ORC -->|Sends Bundle| JITO
    ORC -->|Signs & Submits| CONTRACT
    ORC -->|Logs| LOG
    ORC -->|Retrieves keys| SEC
    CONTRACT -->|Swap| RAY
    CONTRACT -->|Swap| ORCA
    CONTRACT -->|Swap| MET
    JITO -->|Confirms| CONTRACT
    JITO -->|Returns status| ORC
```

---

## 🔄 Flujo de Transacción (Secuencia Detallada)

```mermaid
sequenceDiagram
    participant MON as Monitor Module
    participant DET as Detector Module
    participant JUP as Jupiter SDK
    participant ORC as Orchestrator
    participant JITO as Jito Relay
    participant RPC as RPC Node (Helius)
    participant CON as Contract (Anchor)
    participant POOL as DEX Pools

    loop Cada 100-200ms
        MON->>JUP: Solicitar precios (SOL/USDC, SOL/USDT)
        JUP-->>MON: Precios actuales + rutas
        MON->>DET: Enviar datos de precios
        DET->>DET: Calcular spread y beneficio neto
        alt Beneficio > Umbral (ej. 0.3%)
            DET->>ORC: Oportunidad detectada
            ORC->>JUP: Obtener ruta de arbitraje óptima
            JUP-->>ORC: Ruta (swap A -> B -> C)
            ORC->>ORC: Construir instrucciones (compra + venta)
            ORC->>RPC: Simular transacción
            RPC-->>ORC: Estado de simulación
            alt Simulación exitosa
                ORC->>ORC: Firmar bundle con claves (sin exponer)
                ORC->>JITO: Enviar Jito Bundle (priorización)
                JITO->>CON: Ejecutar instrucciones
                CON->>POOL: Swap Compra (token A -> B)
                CON->>POOL: Swap Venta (token B -> A)
                CON->>CON: Validar saldo final > inicial + fees
                CON-->>JITO: Éxito / Fracaso
                JITO-->>ORC: Confirmación
                ORC->>ORC: Registrar resultado (log + dashboard)
            else Simulación falla
                ORC->>ORC: Descartar oportunidad
                ORC->>LOG: Registrar evento (sin pérdida)
            end
        else Beneficio <= Umbral
            DET->>DET: Esperar siguiente ciclo
        end
    end
```

---

## 🧩 Componentes Detallados

### 1. Off-Chain Engine (Node.js/TypeScript)

| Módulo              | Tecnología                          | Responsabilidad                                                             |
| ------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| **Monitor**         | `@solana/web3.js`, `@jup-ag/api`    | Consulta precios de Jupiter (REST + WebSocket) y mantiene caché de precios. |
| **Detector**        | TypeScript (cálculo con Decimal.js) | Calcula spreads y beneficio neto (incluyendo fees y slippage).              |
| **Orchestrator**    | `jito-ts`, `@coral-xyz/anchor`      | Construye y firma Jito Bundles; gestiona reintentos y fallbacks.            |
| **Logger**          | `pino`, `winston`                   | Registra eventos estructurados (JSON) para auditoría y debugging.           |
| **Secrets Manager** | `dotenv` + AWS SDK                  | Gestiona claves privadas y variables de entorno de forma segura.            |

### 2. On-Chain Layer (Rust/Anchor)

| Componente             | Función                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| **Arbitrage Executor** | Programa principal que ejecuta swaps atómicos (compra/venta).                |
| **Validation Logic**   | Verifica saldo inicial vs. final; revierte si beneficio < 0.                 |
| **Pool Integrations**  | Interactúa con Raydium, Orca y Meteora via CPIs (Cross-Program Invocations). |

### 3. Infraestructura de Red

| Servicio           | Proveedor              | Propósito                                            |
| ------------------ | ---------------------- | ---------------------------------------------------- |
| **RPC Primario**   | Helius (con WebSocket) | Baja latencia (< 50ms) y soporte para transacciones. |
| **RPC Secundario** | Triton (Triton One)    | Fallback con alta disponibilidad.                    |
| **RPC Terciario**  | QuickNode              | Último recurso para evitar downtime.                 |
| **Jito Relay**     | Jito Network           | Envío de bundles privados (evita frontrunning).      |

---

## ⚡ Estrategia de Baja Latencia

| Técnica                     | Implementación                                                               |
| --------------------------- | ---------------------------------------------------------------------------- |
| **Caching de Precios**      | Cache en memoria con TTL de 200ms (evita llamadas innecesarias a Jupiter).   |
| **Conexiones Persistentes** | WebSocket para suscripción a cambios de cuentas (mempool).                   |
| **Geolocalización**         | EC2 en `us-east-1` (cerca de los RPCs de Solana).                            |
| **Compresión de Datos**     | Serialización binaria (Borsh) para instrucciones.                            |
| **Reintentos Asincrónicos** | Envío paralelo a múltiples Jito Relays para mayor probabilidad de inclusión. |
| **Compute Budget**          | Ajuste dinámico de `computeUnitPrice` según congestión.                      |

---

## 🛡️ Seguridad y Gestión de Claves

```mermaid
flowchart LR
    ENV[.env File] -->|Loaded| SEC[Secrets Manager]
    SEC -->|Decrypts| KEYS[Private Keys]
    KEYS -->|Signs| ORC[Orchestrator]
    KEYS -->|Never logged| LOG[Logger]
    
    subgraph "Production"
        AWS[AWS Secrets Manager] -->|Retrieved at startup| ENV
    end
    
    subgraph "Development"
        LOCAL[Local .env] -->|Only for testing| ENV
    end
```

- **Claves privadas:** Nunca en código; se cargan desde variables de entorno (`.env`) o AWS Secrets Manager en producción.
- **Rotación de claves:** Se genera nueva clave por sesión (opcional) para minimizar exposición.
- **Permisos:** Cuenta del bot con balance mínimo para fees (0.05 SOL) y tokens para operaciones.

---

## 📊 Monitoreo y Observabilidad

```mermaid
flowchart TB
    subgraph "Logging Pipeline"
        APP[Bot Application] -->|Logs JSON| PINO[Pino Logger]
        PINO -->|Stream| ELASTIC[Elasticsearch]
        ELASTIC -->|Visualize| KIBANA[Kibana Dashboard]
    end
    
    subgraph "Metrics"
        APP -->|Prometheus metrics| PROM[Prometheus]
        PROM -->|Grafana| GRAF[Grafana]
    end
    
    subgraph "Alerts"
        APP -->|Webhook| TELE[Telegram Bot]
        APP -->|Email| SMTP[SMTP Service]
    end
```

- **Logs:** Estructurados con `pino` y enviados a Elasticsearch para análisis histórico.
- **Métricas:** Latencia de detección, éxito/fallo de bundles, ganancias acumuladas.
- **Alertas:** Notificaciones en tiempo real (Telegram/Slack) para:
  - Oportunidad perdida por latencia (> 500ms).
  - Transacción fallida por error de RPC.
  - Beneficio negativo (potencial pérdida).

---

## 🖥️ Infraestructura Cloud (AWS)

| Servicio                | Propósito                    | Configuración                              |
| ----------------------- | ---------------------------- | ------------------------------------------ |
| **EC2 (t3.medium)**     | Host del bot Node.js         | `us-east-1`, SSD NVMe, Ubuntu 22.04.       |
| **ElastiCache (Redis)** | Cache de precios (opcional)  | TTL de 5s para reducir llamadas a Jupiter. |
| **Secrets Manager**     | Almacenamiento de claves     | Rotación automática cada 30 días.          |
| **CloudWatch**          | Monitoreo de logs y métricas | Alarmas para CPU > 80% o errores críticos. |
| **S3**                  | Backup de logs históricos    | Retención de 30 días.                      |

---

## 🔄 Estrategia de Reintentos y Fallback

| Escenario                     | Acción                                                                 |
| ----------------------------- | ---------------------------------------------------------------------- |
| **RPC Primario Falló**        | Cambiar al RPC Secundario (Triton) en < 100ms.                         |
| **Jito Bundle Rechazado**     | Reintentar con `computeUnitPrice` + 10% hasta 5 veces.                 |
| **Simulación Falló**          | Descartar oportunidad y registrar causa (ej. falta de liquidez).       |
| **Transacción no Confirmada** | Esperar 3 bloques; si no se confirma, reenviar con mayor priorización. |
| **Error en Contrato**         | Congelar el bot y notificar al administrador (pérdida potencial).      |

---

## 🧪 Entornos de Despliegue

| Entorno        | Propósito                 | Cluster | RPCs                        |
| -------------- | ------------------------- | ------- | --------------------------- |
| **Desarrollo** | Pruebas unitarias         | Devnet  | Helius Devnet               |
| **Staging**    | Simulaciones de arbitraje | Testnet | Helius Testnet + Triton     |
| **Producción** | Operaciones reales        | Mainnet | Helius + Triton + QuickNode |

---

## 📦 Dependencias Críticas

| Componente          | Versión | Propósito                      |
| ------------------- | ------- | ------------------------------ |
| `@solana/web3.js`   | 1.87.x  | Conexión RPC y transacciones.  |
| `@coral-xyz/anchor` | 0.29.x  | Framework del contrato.        |
| `jito-ts`           | Última  | SDK para Jito Bundles.         |
| `@jup-ag/api`       | 6.x     | Precios y rutas de Jupiter.    |
| `pino`              | 8.x     | Logging estructurado.          |
| `decimal.js`        | 10.x    | Cálculos financieros precisos. |

---

## 🚀 Plan de Escalabilidad

- **Horizontal:** Múltiples instancias EC2 con balanceo de carga (NLB) para monitorear diferentes pares.
- **Vertical:** Aumentar recursos (CPU/RAM) si la latencia supera los 200ms.
- **Mempool:** Implementar suscripción a WebSocket de Helius para detección más rápida.
- **Base de Datos:** Migrar de logs locales a TimescaleDB para análisis de series temporales.

---

## 🛠️ Herramientas de Desarrollo y CI/CD

| Herramienta           | Uso                                         |
| --------------------- | ------------------------------------------- |
| **GitHub Actions**    | CI/CD: tests, build, despliegue a EC2.      |
| **Jest**              | Pruebas unitarias (off-chain).              |
| **Anchor Test**       | Pruebas de integración (on-chain).          |
| **ESLint + Prettier** | Estilo y calidad de código.                 |
| **Docker**            | Contenerización para entornos consistentes. |

---

## 📝 Notas Finales

- Esta arquitectura prioriza **baja latencia y separación de responsabilidades**.
- Todo el código crítico (cálculo de beneficio, firma de bundles) debe ser probado en simulación antes de producción.
- Documentar cualquier cambio en `CHANGELOG.md` y actualizar este diagrama si se modifica el flujo.
```