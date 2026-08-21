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