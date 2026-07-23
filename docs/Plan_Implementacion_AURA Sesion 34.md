# Plan de Implementación - Sesión 34 (Introducción al Consenso Distribuido) en proyecto: AURA Drone System

El objetivo de este plan es definir qué decisiones de AURA necesitan **consenso** (varias réplicas acordando el mismo valor, en la misma posición del log y con el mismo término) y cuáles pueden resolverse sin él.

La idea que se toma de la sesión es: *el consenso no elimina las fallas, limita qué decisiones pueden confirmarse cuando hay incertidumbre*.

## 1. Qué decisiones de AURA necesitan consenso

En la Sesión 32 se definió qué garantía de lectura necesita cada operación. Acá se define algo distinto: **cómo se acuerda una escritura crítica antes de confirmarla**. La regla para separar es simple: si confirmar dos decisiones distintas sería inaceptable y no alcanza con reconciliar después, se necesita acuerdo.

### Operaciones que sí requieren acuerdo

| Necesidad de AURA | Por qué requiere acuerdo |
|---|---|
| Asignación de un dron a una misión | Un dron no puede quedar en dos misiones activas |
| Líder vigente de `gestor-flota` | Un solo coordinador debe aceptar escrituras críticas |
| Bloqueo por mantenimiento crítico | Todas las zonas deben ver el mismo estado del dron |
| Log de eventos críticos | Se necesita un orden común para recuperar y auditar |
| Rechazo de un líder viejo | El `term` debe ser aceptado por todo el grupo |

### Operaciones que NO requieren consenso

Acá el consenso solo agregaría latencia y complejidad sin proteger nada:

* Dashboard global de flota y mapa.
* Telemetría histórica y métricas agregadas.
* Reportes diarios y vistas materializadas.

Estas siguen con consistencia eventual, tal como quedó definido en el plan de la Sesión 32.

### Cómo se va a implementar en AURA

AURA **no va a escribir su propio protocolo de consenso**. La decisión profesional es consumirlo como servicio:

| Opción | Cuándo aplica en AURA |
|---|---|
| Sin consenso | Dashboard, métricas y telemetría no crítica |
| Líder + quórum | Estado crítico de flota, si se opera con réplicas propias |
| Servicio gestionado (etcd, ZooKeeper, Consul, BD distribuida) | Recomendado para las garantías críticas de producción |

Lo que sí se implementa en el proyecto es la **regla de aceptación** del lado del recurso protegido: aunque el consenso lo dé etcd, `gestor-flota` igual tiene que validar `term`, mayoría e idempotencia antes de persistir.

## 2. Reglas de aceptación de una escritura crítica

Toda escritura sobre el estado crítico de un dron debe pasar estas cinco validaciones, en este orden:

1. **Término vigente:** si el comando llega con un `leaderTerm` menor al término actual del grupo, se rechaza con `stale-leader-term`. Un líder viejo que despierta no puede confirmar nada.
2. **Idempotencia:** si la `Idempotency-Key` ya fue aplicada, se devuelve el resultado anterior sin volver a ejecutar la operación.
3. **Invariante de negocio:** si el dron ya tiene una misión activa distinta, se rechaza. El rechazo también se registra en el log, para que las réplicas cuenten la misma historia.
4. **Mayoría:** la entrada se agrega al log sin comprometer, y solo se compromete si la aceptan `⌊N/2⌋ + 1` réplicas. Con N=3 el quórum es 2.
5. **Aplicación única:** recién con el commit se cambia el estado, y se cambia una sola vez.

El esquema es el mismo que se vio en clase: **proponer → ordenar → replicar → confirmar → aplicar**.

## 3. Recuperación ante falla parcial

El punto clave de la sesión es que un timeout **no prueba** que la operación falló. Puede haber quedado confirmada por la mayoría y solo se perdió la respuesta. Por eso Centro-Logística sigue este procedimiento:

1. **Detectar** — timeout, caída del líder o partición.
2. **Confirmar** — preguntar por el estado real antes de asumir cualquier cosa.
3. **Reintentar** — con la **misma** `Idempotency-Key`. Una clave nueva convierte la incertidumbre en una operación duplicada.
4. **Reconciliar** — alinear log, eventos y réplicas atrasadas.
5. **Auditar** — dejar evidencia, métricas y el registro del incidente.

Reiniciar un servicio no es recuperar: recuperar es cerrar la incertidumbre.

## 4. Invariantes que no se deben romper

Estas son las reglas que el sistema no puede violar ni siquiera estando degradado:

| Invariante | Qué la protege |
|---|---|
| Un dron no tiene dos misiones activas | Consenso o validación fuerte en el recurso |
| Un líder viejo no confirma comandos | `leaderTerm` + fencing |
| Un retry no duplica la asignación | `Idempotency-Key` |
| Una cancelación tiene causa trazable | `causedBy` + `correlationId` (Sesión 32) |
| Una réplica atrasada no decide | Ruta fuerte para acciones críticas |
| Un evento crítico no se pierde | Durabilidad + retry idempotente |

El criterio es que **el sistema puede degradarse, pero no puede inventar un estado que nadie acordó**. Si no hay mayoría, la respuesta correcta es "no confirmado", no una asignación optimista.

## 5. Métricas a Implementar

Para poder observar el consenso y la recuperación se deben registrar:

* `leader_changes_total`: cuántas veces cambió el líder. Muchos cambios indican inestabilidad o timeouts mal calibrados.
* `old_leader_rejected_total`: cuántos comandos se rechazaron por venir con un término viejo.
* `idempotent_retry_total`: cuántos reintentos se resolvieron sin duplicar la operación.
* `quorum_unavailable_total`: cuántas veces no se alcanzó mayoría y la escritura quedó sin confirmar.
* `consensus_commit_latency_ms`: cuánto cuesta realmente confirmar una decisión crítica.
* `recovery_time_seconds`: cuánto demoró el sistema en cerrar la incertidumbre después de una falla.

## 6. Alcance y límites del plan

Para ser explícito con lo que se hace y lo que no:

* Se implementa la **intuición** de Raft (líder, término, log replicado, mayoría y commit) en un laboratorio acotado y ejecutable.
* **No** se implementa Raft ni Paxos real, ni membresía productiva, ni transacciones distribuidas, ni failover real de servicios.
* Las réplicas del laboratorio son objetos en memoria: no hay red, ni disco, ni pérdida real de mensajes.
* El uso de etcd, ZooKeeper o Consul queda como recomendación arquitectónica, no como parte de la implementación del curso.
