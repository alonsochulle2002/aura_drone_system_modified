# Plan de Implementación - Sesión 32 (Modelos de Consistencia) en proyecto: AURA Drone System

El objetivo de este plan es definir qué nivel de consistencia (fuerte, eventual o causal) se va a aplicar en la arquitectura del sistema AURA.

El criterio base que se toma de la sesión es: *fuerte para decidir, eventual para observar y causal para explicar*.

## 1. Definición de los modelos para el plan Aura

En lugar de usar un solo modelo para todo el sistema, se va a separar las operaciones de AURA según la intención de uso de cada dato:

### Consistencia Fuerte (Operaciones Críticas)
Se usará consistencia fuerte para toda operación que implique una toma de decisión donde un dato viejo o *stale* ponga en riesgo la operación.
* **Asignación de drones:** La lectura antes de asignar siempre debe ir directo al servicio gestor-flota. Así evitamos asignar una misión a un dron que ya fue tomado por otro operador hace unos segundos.
* **Bloqueo por mantenimiento y validaciones de batería:** Siempre validar contra el estado fuerte. No se puede basar en una réplica atrasada para decisiones de seguridad de vuelo.

### Consistencia Eventual (Vistas Operativas y Telemetría)
Se usará consistencia eventual para los componentes que solo "informan", donde se puede tolerar un ligero atraso en la visualización.
* **Dashboard Global y Reportes:** El listado general de drones y el mapa usarán este modelo. Nos ayuda a que el sistema sea rápido y escale sin sobrecargar la base de datos principal.
* **Mitigación en el Frontend:** Para que el usuario no se confunda, el dashboard mostrará hace cuánto se actualizó la data (`dataAgeMs` o "Actualizado hace 4 segundos").

### Consistencia Causal (Eventos y Trazabilidad)
Se usará consistencia causal para mantener el orden lógico en el historial de los drones. Un efecto nunca debería ser visible en el sistema antes que su causa.
* **Manejo de Fallas (Ej. Batería Crítica -> Misión Cancelada):** Si un dron cancela su misión por falta de batería, el evento derivado tiene que referenciar al original.
* **Aplicación teórica:** Los eventos en el sistema tendrán que viajar obligatoriamente con metadatos como `causedBy` y `correlationId`.

### Resumen de criterio aplicado
AURA implementará esta regla estricta: *"El dashboard informa, pero el backend decide"*. Si un operador ve un dron "Disponible" en su dashboard (que podría estar leyendo un dato desactualizado) y manda la orden de "Asignar", el sistema NO confía en esa vista.

## 2. Matriz de consistencia por operación

Esta matriz es la que se va a usar como referencia al momento de programar cada endpoint, para no tener que discutir el modelo caso por caso:

| Operación o vista | Servicio dueño del dato | Modelo | Justificación | Mitigación |
|---|---|---|---|---|
| Asignar dron a una misión | `gestor-flota` | Fuerte | No se puede permitir doble asignación | Releer el estado en el primario antes de persistir |
| Validar batería antes de despegar | `monitor-telemetria` → `gestor-flota` | Fuerte | Es una decisión de seguridad de vuelo | Rechazar si el dato no viene del dueño fuerte |
| Bloquear dron por mantenimiento | `gestor-flota` | Fuerte + causal | Cambia estado crítico y debe explicar por qué | Guardar el `causedBy` del evento que lo originó |
| Dashboard global de flota | Réplica de lectura | Eventual | Solo informa, tolera un atraso corto | Mostrar `lastUpdatedAt` y `dataAgeMs` |
| Histórico de telemetría | `monitor-telemetria` | Eventual | Alto volumen y consulta de análisis posterior | No habilitar acciones críticas desde esa vista |
| Cancelación por batería crítica | `centro-logistica` | Causal + fuerte para el estado | El efecto no se entiende sin su causa | `causedBy` y `correlationId` obligatorios |
| Auditoría de eventos | Bus de eventos / auditoría | Causal + append-only | Se necesita reconstruir la historia completa | Ordenar por agregado, no por reloj físico |
| Reporte diario de entregas | `centro-logistica` | Eventual | Es una consolidación diferida | Indicar la fecha de corte del reporte |

## 3. Costo de elegir mal el modelo

Es importante dejar registrado que el error se puede dar en los dos sentidos, no solo por quedarse corto:

* **Si se usa eventual para decidir:** una réplica atrasada habilita la doble asignación. El problema no es que el dato esté siempre mal, sino que puede estar viejo justo en el momento en que importa.
* **Si se usa fuerte para todo:** sube la latencia, sube el costo y todo el sistema queda dependiendo del primario. El dashboard no gana nada operativo con eso y sí pierde escalabilidad.

Por eso el criterio que adopta AURA es: **la consistencia correcta es la mínima que protege la operación**.

## 4. Métricas a Implementar

Para manejar el control y conocer bien las consistencias se deben manejar las siguientes métricas:

* `replica_lag_ms`: Para saber cuántos milisegundos de atraso tienen las vistas del dashboard respecto a la realidad.
* `dashboard_data_age_ms`: La edad del dato que efectivamente se le está mostrando al operador en pantalla.
* `stale_read_detected_total`: Cuántas veces se detectó que una lectura devolvió una versión anterior a la confirmada.
* `strong_validation_rejected_total`: Cuántas veces el modelo fuerte salvó a un operador de tomar una mala decisión basada en un *stale*.
* `causal_order_violation_total`: Para detectar si en algún momento los eventos de causa y efecto llegaron cruzados.

## 5. Alcance del plan

Para ser honestos con lo que este plan cubre y lo que no:

* Define la política de lectura y escritura por operación; no implementa replicación real ni base de datos distribuida.
* La consistencia causal se resuelve con metadata en los eventos (`causedBy`, `correlationId`), no con vector clocks completos.
* El acuerdo entre réplicas sobre una escritura crítica (quórum, líder, término y log) no se resuelve acá: eso corresponde a la Sesión 34 de consenso distribuido.
