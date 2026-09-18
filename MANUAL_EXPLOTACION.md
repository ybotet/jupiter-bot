 # Manual de Explotación y Guía de Usuario

 ## Dashboard de Monitoreo MEV

 **Producto:** Jupiter Bot, plataforma de monitorización y ejecución de arbitraje en Solana  
 **Audiencia:** operadores, analistas de rendimiento y administradores técnicos  
 **Entorno de referencia:** el panel puede mostrar `devnet`, `testnet` o `mainnet-beta`; compruebe siempre el cluster antes de interpretar una ganancia o realizar una acción operativa.

 > **Advertencia financiera:** el dashboard informa de oportunidades y resultados del bot, pero no sustituye la validación on-chain. No use los datos de `devnet` para estimar beneficios reales ni modifique parámetros de producción sin confirmar primero el entorno y los fondos implicados.

 ## Índice

 - [1. Resumen ejecutivo](#1-resumen-ejecutivo)
 - [2. Cómo leer el dashboard](#2-cómo-leer-el-dashboard)
 - [3. Glosario](#3-glosario-de-conceptos-clave)
 - [4. Métricas y tarjetas KPI](#4-métricas-y-tarjetas-kpi)
 - [5. Gráficos](#5-explicación-de-los-gráficos)
 - [6. Tablas y estados](#6-guía-de-tablas-y-estados)
 - [7. Procedimientos operativos](#7-flujo-de-trabajo-operativo)
 - [8. Configuración, límites y persistencia](#8-configuración-límites-y-persistencia)
 - [9. Diagnóstico y escalado](#9-diagnóstico-y-escalado)
 - [10. Buenas prácticas](#10-buenas-prácticas)

 ## 1. Resumen ejecutivo

 ### 1.1 Propósito

 El Dashboard de Monitoreo MEV es la vista de supervisión del bot de arbitraje. Reúne en un mismo lugar:

 - el estado operativo del proceso y su conexión con la API;
 - el número de oportunidades detectadas;
 - el volumen de bundles enviados, confirmados y fallidos;
 - el beneficio neto acumulado en USDC;
 - las oportunidades recientes y su ciclo de vida;
 - la evolución histórica de la actividad y del beneficio.

 La información llega desde la API REST del bot. La pantalla consulta el estado y las nuevas oportunidades aproximadamente cada 2 segundos por defecto, sin recargar la página. El dashboard conserva hasta 50 instantáneas de estado y hasta 100 oportunidades visibles en el navegador.

 ### 1.2 Decisiones que permite tomar

 El panel ayuda a decidir si:

 1. el bot está funcionando y enviando señales de vida;
 2. existe actividad suficiente para investigar una oportunidad;
 3. las oportunidades se convierten en bundles confirmados;
 4. los fallos apuntan a congestión, RPC, slippage, liquidez o contrato;
 5. el beneficio acumulado mantiene una tendencia positiva;
 6. conviene pausar la operación y escalar el incidente.

 No permite por sí solo cambiar la estrategia en el servidor, retirar fondos, ni confirmar que una transacción es rentable sólo porque haya sido detectada.

 ### 1.3 Recorrido de la pantalla

 - **Cabecera:** estado, cluster, versión, hora del último refresco e intervalo de consulta.
 - **Tablero:** KPIs, beneficio acumulado y oportunidades recientes.
 - **Métricas:** gráficos construidos con el historial local del navegador.
 - **Historial:** snapshots de estado que cambiaron durante la sesión o sesiones persistidas.
 - **Configuración:** ajustes de presentación y consulta locales al navegador.

 ## 2. Cómo leer el dashboard

 ### 2.1 Estado general

 El estado de la cabecera procede de `GET /api/status` y puede ser:

 | Estado      | Significado operativo                                                                   | Acción inicial                                                |
 | ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
 | `starting`  | El proceso está iniciando y todavía puede no haber métricas completas.                  | Esperar el primer heartbeat y el primer refresco correcto.    |
 | `running`   | El bot está activo y publicando su estado.                                              | Continuar supervisando confirmaciones, errores y beneficio.   |
 | `paused`    | El proceso está detenido temporalmente para no ejecutar o por una condición de control. | Confirmar el motivo en logs y reanudar sólo con autorización. |
 | `stopped`   | El proceso no está operando.                                                            | Revisar disponibilidad, despliegue y logs antes de iniciar.   |
 | `sin datos` | El navegador aún no ha recibido una respuesta válida.                                   | Comprobar API, URL base, red y mensaje de error.              |

 El **último heartbeat** es la marca temporal del último ciclo de monitorización publicado por el backend. No debe confundirse con el último cambio de una oportunidad.

 > **Regla de seguridad:** si el cluster mostrado no es el esperado, detenga cualquier operación antes de analizar el beneficio. Un resultado de `devnet` no representa fondos de `mainnet-beta`.

 ### 2.2 Actualización y conectividad

 La cabecera muestra el último refresco que recibió el navegador. Si aparece un banner de error, el panel conserva los datos anteriores, pero esos datos ya no deben tratarse como actuales. El endpoint ligero `/api/health` devuelve `status: ok` cuando el servidor responde, aunque una respuesta saludable no garantiza que Jupiter, el RPC o Jito estén operativos.

 ## 3. Glosario de conceptos clave

 | Término                  | Definición                                                                                                |
 | ------------------------ | --------------------------------------------------------------------------------------------------------- |
 | **Arbitraje**            | Operación que intenta comprar un activo a un precio y venderlo a otro precio dentro de una ruta rentable. |
 | **Ruta**                 | Secuencia de swaps, por ejemplo `SOL → USDC → USDT → SOL`.                                                |
 | **Oportunidad**          | Diferencia de precio detectada que todavía puede superar los costes y el umbral configurado.              |
 | **Beneficio bruto**      | Resultado estimado antes de descontar fees, tip de Jito y slippage.                                       |
 | **Beneficio neto**       | Resultado estimado después de todos los costes de ejecución.                                              |
 | **Fee**                  | Comisión cobrada por el intercambio o por la red.                                                         |
 | **Tip de Jito**          | Pago de prioridad asociado al envío del bundle a Jito.                                                    |
 | **Slippage**             | Variación desfavorable entre el precio esperado y el precio efectivo de ejecución.                        |
 | **Bps / puntos básicos** | Unidad porcentual: 100 bps = 1%; 50 bps = 0,5%.                                                           |
 | **Bundle**               | Conjunto ordenado de transacciones que se envía al relay de Jito para intentar una ejecución coordinada.  |
 | **Confirmado**           | El bundle o la transacción fue incluido y confirmado según la comprobación del sistema.                   |
 | **RPC**                  | Servicio que permite consultar la red Solana y enviar o simular transacciones.                            |
 | **Heartbeat**            | Señal periódica que demuestra que el proceso sigue publicando actividad.                                  |
 | **Snapshot**             | Copia de las métricas y del estado en un instante concreto.                                               |
 | **Cursor `since`**       | Marca temporal usada para pedir sólo oportunidades posteriores y evitar duplicados.                       |

 ## 4. Métricas y tarjetas KPI

 ### 4.1 Fórmula financiera

 La estimación de beneficio neto usada por la estrategia parte del ingreso bruto de la ruta (`grossRevenue`, que el feed presenta como beneficio bruto estimado) y es:

 $$
 	ext{Beneficio neto} = \text{Ingreso bruto} - \text{Fees de Jupiter} - \text{Tip de Jito} - \text{Coste de slippage}
 $$

 Con la configuración actual, el coste de slippage se estima como:

 $$
 	ext{Coste de slippage} = \text{Ingreso bruto} \times \frac{\text{slippage en bps}}{10\,000}
 $$

 Todos los importes deben estar normalizados en la misma moneda de referencia, normalmente USDC. El backend calcula con precisión decimal; el navegador convierte el valor sólo para colorear y representar gráficos.

 ### 4.2 Tarjetas del tablero

 | KPI                          | Qué mide                                                                             | Fuente                                            | Lectura normal                                                           | Señal de alerta y acción                                                                                                                  |
 | ---------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
 | **Detectadas**               | Total acumulado de oportunidades identificadas por el orquestador.                   | `metrics.opportunitiesDetected` en `/api/status`. | Aumenta cuando el monitor encuentra rutas candidatas.                    | Se mantiene en cero pese a precios disponibles: revisar monitor, Jupiter, pares y RPC. Un salto aislado no implica rentabilidad.          |
 | **Bundles enviados**         | Total de bundles entregados al relay de Jito.                                        | `metrics.bundlesSubmitted`.                       | Crece cuando una oportunidad supera los controles y se intenta ejecutar. | Aumenta sin confirmaciones: revisar congestión, relay, prioridad y estado de los reintentos.                                              |
 | **Bundles confirmados**      | Total de bundles confirmados on-chain.                                               | `metrics.bundlesConfirmed`.                       | Debe crecer con los envíos aceptados y válidos.                          | Si permanece por debajo de enviados, calcular la tasa de confirmación y revisar fallos o expiraciones.                                    |
 | **Bundles fallidos**         | Total de bundles rechazados, expirados o no confirmados según el flujo de ejecución. | `metrics.bundlesFailed`.                          | Bajo o estable en condiciones normales.                                  | Un incremento sostenido requiere revisar RPC/Jito, slippage, liquidez y errores del contrato; no aumentar fees automáticamente sin causa. |
 | **Beneficio neto acumulado** | Resultado acumulado después de costes, en USDC.                                      | `metrics.netProfitUsdc`, como cadena decimal.     | Positivo y coherente con los bundles confirmados.                        | Cero puede ser correcto al inicio. Negativo o descendente: pausar la operación si persiste y auditar fees, tip, slippage y rutas.         |

 ### 4.3 Indicadores derivados útiles

 El dashboard no muestra estas tasas como tarjetas independientes, pero el operador puede calcularlas:

 $$
 	ext{Tasa de confirmación} = \frac{\text{Bundles confirmados}}{\text{Bundles enviados}} \times 100
 $$

 $$
 	ext{Tasa de fallo} = \frac{\text{Bundles fallidos}}{\text{Bundles enviados}} \times 100
 $$

 Si no hay bundles enviados, no se debe dividir: la tasa es **no aplicable**, no 0% de confirmación.

 ## 5. Explicación de los gráficos

 Los gráficos se encuentran en la pestaña **Métricas** y se alimentan del historial local, no de una base histórica independiente. Sólo se crea una nueva instantánea cuando cambia el estado o una métrica relevante; un heartbeat aislado no genera necesariamente otro punto.

 ### 5.1 Evolución temporal

 Es un gráfico de líneas con dos ejes verticales:

 - **Eje X:** hora local del navegador (`HH:MM:SS`) para cada snapshot.
 - **Eje Y izquierdo, línea verde:** beneficio neto acumulado en USDC.
 - **Eje Y derecho, línea azul:** número acumulado de oportunidades detectadas.

 Cómo interpretarlo:

 - ambas líneas ascendentes: aumenta la actividad y el resultado acumulado;
 - oportunidades ascendentes y beneficio plano: hay detección, pero no conversión o el coste elimina la ventaja;
 - beneficio descendente: investigar pérdidas, reinicios de contadores o correcciones de estado;
 - una línea aparentemente muy plana: comparar su eje correspondiente, porque las escalas son distintas.

 > **Consejo:** no compare la altura visual de la línea verde con la azul. Es como observar kilómetros y litros en la misma hoja: comparten tiempo, pero no unidad.

 ### 5.2 Ganancias diarias

 Es un gráfico de barras agrupado por día calendario en la zona horaria del navegador.

 - **Eje X:** fecha local.
 - **Eje Y:** variación del beneficio neto en USDC.
 - **Barra verde:** variación diaria no negativa.
 - **Barra roja:** variación diaria negativa.

 El valor diario se calcula como último snapshot del día menos primer snapshot del día:

 $$
 	ext{Ganancia diaria} = \text{Beneficio neto del último snapshot} - \text{Beneficio neto del primer snapshot}
 $$

 Una barra roja puede indicar una pérdida real o un reinicio de métricas durante ese día. Confirme siempre contra logs y transacciones antes de concluir que hubo una pérdida de fondos.

 ### 5.3 Limitaciones de interpretación

 - El historial está limitado a 50 snapshots.
 - El historial se guarda en `localStorage` del navegador; limpiar el almacenamiento o cambiar de navegador lo elimina de esa vista.
 - Los gráficos no prueban por sí solos que una operación haya liquidado fondos; use el `transactionId` y la exploración on-chain cuando exista.

 ## 6. Guía de tablas y estados

 ### 6.1 Tabla de oportunidades recientes

 La tabla se ordena por detección más reciente y muestra hasta 100 oportunidades en el buffer del cliente. La vista aplica el filtro de slippage configurado.

 | Columna                   | Significado                                                                                 |
 | ------------------------- | ------------------------------------------------------------------------------------------- |
 | **Ruta**                  | Secuencia de tokens y swaps evaluada por la estrategia.                                     |
 | **Beneficio neto (USDC)** | Estimación después de costes; se conserva como decimal para no perder precisión.            |
 | **Slippage**              | Slippage tolerado para la ruta, expresado en bps. Para convertir a porcentaje: `bps / 100`. |
 | **Estado**                | Etapa actual de la oportunidad en su ciclo de ejecución.                                    |

 Estados de oportunidad:

 | Estado      | Significado                                               | Tratamiento operativo                                       |
 | ----------- | --------------------------------------------------------- | ----------------------------------------------------------- |
 | `detected`  | Detectada, aún sin envío confirmado.                      | Evaluar beneficio, slippage y antigüedad.                   |
 | `submitted` | Bundle enviado al relay.                                  | Esperar confirmación; no duplicar manualmente la operación. |
 | `confirmed` | Bundle confirmado.                                        | Correlacionar con firma, beneficio realizado y logs.        |
 | `rejected`  | El relay, simulación o ejecución rechazó el intento.      | Leer `reason`, investigar causa y observar reintentos.      |
 | `expired`   | La oportunidad perdió vigencia o no se confirmó a tiempo. | No reutilizarla; analizar latencia y frescura de precios.   |

 Los colores son una ayuda visual del estado, no una garantía financiera. Una oportunidad en verde puede ser una estimación; una confirmación on-chain es la evidencia operativa.

 ### 6.2 Tabla de historial de estados

 La pestaña **Historial** muestra, de más reciente a más antiguo:

 - **Instante:** hora local de captura del snapshot;
 - **Estado:** estado global del bot;
 - **Detectadas:** oportunidades acumuladas;
 - **Confirmados:** bundles confirmados acumulados;
 - **Fallidos:** bundles fallidos acumulados;
 - **Beneficio (USDC):** beneficio neto acumulado en ese instante.

 El botón **Vaciar historial** sólo elimina los snapshots locales del navegador. No borra logs, transacciones, oportunidades del backend ni fondos.

 ### 6.3 Filtrado, ordenación y actualización

 No existe una búsqueda libre ni ordenación manual en la implementación actual. La tabla de oportunidades se refresca mediante un cursor temporal y deduplicación por `id`; la tabla de historial se ordena automáticamente por instante descendente. Si falta una oportunidad, compruebe si el buffer backend ya superó su capacidad o si el navegador estuvo desconectado durante el intervalo.

 ## 7. Flujo de trabajo operativo

 ### 7.1 Inicio de turno

 1. Abra el dashboard y confirme el **cluster**, la **versión** y la URL de API.
 2. Espere el primer refresco y compruebe que el estado pasa de `starting` a `running`.
 3. Verifique que el heartbeat es reciente y que no aparece el banner de error.
 4. Revise que las métricas comienzan desde el valor esperado para ese proceso.
 5. Confirme que el beneficio mínimo y el slippage visible corresponden al entorno autorizado.

 ### 7.2 Hay oportunidades, pero no se envían bundles

 **Síntoma:** `Detectadas` aumenta, mientras `Bundles enviados` permanece igual.

 1. Revise el beneficio neto de las oportunidades.
 2. Compruebe si superan el umbral de beneficio y respetan el slippage máximo.
 3. Verifique que la ruta esté conectada y que haya liquidez suficiente.
 4. Consulte logs del orquestador y de simulación.
 5. No baje el umbral sólo para forzar actividad: valide antes fees, tip y riesgo.

 ### 7.3 Se envían bundles, pero fallan o expiran

 **Síntoma:** `Bundles enviados` y `Bundles fallidos` crecen, pero `Bundles confirmados` no acompaña.

 1. Identifique el `transactionId` o bundle id disponible.
 2. Determine si el motivo es rechazo, timeout, simulación, RPC o contrato.
 3. Compruebe el estado de Helius, Triton, QuickNode y Jito.
 4. Revise slippage, liquidez, blockhash y prioridad; el sistema puede reintentar hasta cinco veces con aumento de `computeUnitPrice`.
 5. Si el fallo persiste o aparece un error de contrato, pause y escale al administrador.

 > **No repita manualmente una oportunidad `submitted` o `confirmed`.** Podría duplicar la exposición. Correlacione primero la firma y el estado on-chain.

 ### 7.4 El beneficio neto es negativo

 1. Confirme que está en el cluster correcto.
 2. Compare beneficio bruto, fees de Jupiter, tip de Jito y slippage.
 3. Revise si hubo reinicio de métricas, que puede producir una caída aparente.
 4. Compruebe varias operaciones confirmadas, no sólo la última detección.
 5. Si la tendencia negativa persiste, pause el bot y escale con timestamps, rutas y firmas.

 ### 7.5 Se pierde la conexión con la API

 1. Observe la hora del último refresco y el mensaje HTTP mostrado.
 2. Compruebe `/api/health` y la URL base configurada.
 3. Verifique que el proceso backend siga activo y que el puerto sea accesible.
 4. Compruebe RPC y logs del servidor; el navegador no debe considerarse fuente de verdad mientras no se recupere.
 5. Tras recuperar la conexión, compruebe si hubo un salto temporal en el feed y correlacione con logs.

 ### 7.6 Cierre de turno

 1. Registre cluster, periodo observado, beneficio, confirmados y fallidos.
 2. Anote incidentes con hora, ruta, estado y motivo.
 3. No vacíe el historial antes de conservar las evidencias necesarias.
 4. Si el bot queda detenido, confirme el estado `stopped` y el último heartbeat conocido.

 ## 8. Configuración, límites y persistencia

 | Ajuste                   | Valor por defecto | Efecto real                                                                                                 |
 | ------------------------ | ----------------: | ----------------------------------------------------------------------------------------------------------- |
 | **Intervalo de polling** |          2.000 ms | Frecuencia con la que el navegador consulta estado y oportunidades. El mínimo aplicado es 500 ms.           |
 | **URL base de la API**   |             Vacía | Usa el mismo origen que sirve el HTML. Puede apuntar a otro backend si está autorizado.                     |
 | **Beneficio mínimo**     |         0,10 USDC | Umbral de resaltado de la interfaz para el tablero. No cambia todavía la estrategia del servidor.           |
 | **Slippage máximo**      |     50 bps (0,5%) | Oculta del listado las oportunidades que superan ese límite. No modifica por sí solo la ejecución on-chain. |

 Los ajustes y el historial se almacenan en `localStorage`. **Restaurar valores por defecto** sólo cambia la configuración local. Para modificar la estrategia efectiva deben cambiarse las variables o configuración del backend siguiendo el procedimiento de despliegue aprobado.

 > **Atención:** reducir el intervalo de polling por debajo de 500 ms no acelera el panel: el cliente lo limita para evitar saturar la API. Un intervalo menor tampoco garantiza menor latencia de ejecución del bot.

 ## 9. Diagnóstico y escalado

 Escale al administrador cuando ocurra cualquiera de estas condiciones:

 - estado `paused` o `stopped` inesperado;
 - heartbeat ausente o claramente antiguo;
 - aumento sostenido de bundles fallidos o expirados;
 - beneficio neto negativo en operaciones confirmadas;
 - fallo simultáneo de RPC primario, secundario y terciario;
 - error de contrato, cuenta inválida o problema de firma;
 - discrepancia entre dashboard, logs y explorador de Solana.

 Incluya en el reporte: cluster, intervalo, hora local y UTC si es posible, estado, métricas, ruta, slippage, `transactionId` o firma, mensaje saneado y últimos eventos de log. Nunca adjunte `PRIVATE_KEY`, tokens, webhooks, claves JSON ni URLs con credenciales.

 ## 10. Buenas prácticas

 - Use `devnet` para pruebas y fondos mínimos; reserve `mainnet-beta` para operación autorizada.
 - Interprete importes en USDC y unidades de token normalizadas; no compare importes brutos de tokens distintos.
 - Trate el beneficio mostrado como estimación hasta disponer de confirmación on-chain.
 - Mantenga abierta la pestaña sólo como apoyo operativo: los logs del backend y el explorador son fuentes complementarias.
 - Documente toda modificación de umbrales, slippage o prioridad.
 - No exponga capturas que contengan identificadores sensibles ni comparta secretos en tickets.
 - Ante duda entre velocidad y seguridad de fondos, pause y escale.

 ### Referencias del proyecto

 - [Especificación funcional](spec.md)
 - [Arquitectura técnica](ARCHITECTURE.md)
 - [Plan de implementación](tasklist.md)
 - [Memoria técnica consolidada](memory.md)
