# Sesión 34 — Laboratorio de consenso distribuido

## Objetivo

Aplicar la intuición de Raft a una decisión crítica real de AURA: la asignación de un dron. La sesión no implementa un protocolo de consenso; lo que se demuestra es **qué escrituras se pueden confirmar y cuáles no** cuando el grupo de réplicas está parcialmente degradado.

La pregunta central es:

```text
¿Puedo confirmar esta escritura crítica, o solo puedo decir que no lo sé todavía?
```

La evidencia que se usa para responder:

- término (`term`) vigente del grupo y rechazo de líderes viejos;
- log replicado con posición (`index`) y término por entrada;
- mayoría (`⌊N/2⌋ + 1`) como condición para hacer commit;
- `Idempotency-Key` para que un retry no duplique la operación;
- invariante de negocio: un dron no puede tener dos misiones activas;
- diferencia entre estado *committed* y estado *uncommitted*.

## Escenario base

Tres réplicas de flota con quórum de 2. `Drone-Alpha-1` parte en `AVAILABLE` y el log en la posición 18.

| Réplica | Rol inicial | Estado | Index | Term |
|---|---|---|---|---|
| `Fleet-R1` | Leader | AVAILABLE | 18 | 8 |
| `Fleet-R2` | Follower | AVAILABLE | 18 | 8 |
| `Fleet-R3` | Follower | AVAILABLE | 18 | 8 |

Dos centros logísticos compiten por el mismo dron: `LC-Norte` pide `Mission-N100` y `LC-Centro` pide `Mission-C200`.

## Comandos

Desde `services/gestor-flota`:

```bash
npm run lab:consensus -- --commit-por-mayoria
```

```bash
npm run lab:consensus -- --lider-viejo-rechazado
```

```bash
npm run lab:consensus -- --retry-idempotente
```

```bash
npm run lab:consensus -- --sin-quorum
```

Salida JSON:

```bash
npm run lab:consensus -- --retry-idempotente --json
```

Archivo implementado: `services/gestor-flota/src/consensus-lab-alonso.js`.

## Modos

| Modo | Decisión esperada | Qué demuestra |
|---|---|---|
| `commit-por-mayoria` | `committed` | Una mayoría de 2 de 3 confirma una sola historia; la solicitud perdedora queda registrada como rechazo en el log. |
| `lider-viejo-rechazado` | `rejected` | Después de una elección, un comando con `term` viejo se rechaza sin tocar el estado. |
| `retry-idempotente` | `accepted-idempotent` | Un timeout no significa fallo: el retry con la misma clave devuelve el resultado ya aplicado en vez de duplicarlo. |
| `sin-quorum` | `uncommitted` | Sin mayoría la entrada queda en el log pero no se compromete, y el estado no cambia. |

## Ejemplos de ejecución

### 1. Commit por mayoría

```bash
npm run lab:consensus -- --commit-por-mayoria
```

```text
Cluster: N=3 quorum=2 lider=Fleet-R1 term=8

Pasos:
- [committed] LC-Norte: Mission-N100 log[19] term=8 acks=Fleet-R1+Fleet-R2 majority-ack
- [rejected] LC-Centro: Mission-C200 log[20] drone-already-assigned

Log de flota:
- log[18] term=8 status=AVAILABLE (committed)
- log[19] term=8 assign Mission-N100 (committed)
- log[20] term=8 reject Mission-C200 (committed)

Estado final: Drone-Alpha-1 IN_MISSION Mission-N100
```

**Explicación:** `LC-Norte` llega primero y el líder agrega la asignación en `log[19]`. Con el ACK de `Fleet-R2` se alcanzan 2 de 3 réplicas, que es el quórum, así que la entrada se compromete y recién ahí cambia el estado del dron. Cuando `LC-Centro` pide el mismo dron, la solicitud **no se descarta en silencio**: queda como un rechazo explícito en `log[20]`. Eso es justamente lo que diferencia consenso de un simple lock — las tres réplicas terminan con el mismo log y cuentan la misma historia, incluyendo el rechazo.

### 2. Líder viejo rechazado

```bash
npm run lab:consensus -- --lider-viejo-rechazado
```

```text
Cluster: N=3 quorum=2 lider=Fleet-R2 term=9

Pasos:
- [leader-elected] Fleet-R2: term=9
- [rejected] Fleet-R1-old-leader: Mission-N100 stale-leader-term
- [committed] LC-Norte: Mission-N100 log[19] term=9 acks=Fleet-R2+Fleet-R3 majority-ack

Metricas:
- leader_changes_total: 1
- old_leader_rejected_total: 1
```

**Explicación:** `Fleet-R1` cae, los followers sospechan y se elige a `Fleet-R2` con `term=9`. Cuando `Fleet-R1` vuelve, todavía cree que es líder e intenta coordinar con `term=8`. El grupo compara términos y lo rechaza con `stale-leader-term` **antes** de mirar nada del estado del dron. Esto es lo que evita el split-brain: sin el término, tendríamos dos nodos aceptando escrituras y dos historias incompatibles. La métrica `old_leader_rejected_total` deja evidencia de que la protección se activó.

### 3. Retry idempotente

```bash
npm run lab:consensus -- --retry-idempotente
```

```text
Pasos:
- [committed] LC-Norte (respuesta perdida por timeout): Mission-N100 log[19] term=8 acks=Fleet-R1+Fleet-R2 majority-ack
- [leader-elected] Fleet-R2: term=9
- [accepted-idempotent] LC-Norte (retry con misma key K1): Mission-N100 log[19] term=8 already-applied
- [rejected] LC-Norte (retry con key nueva K9): Mission-N101 log[20] drone-already-assigned

Estado final: Drone-Alpha-1 IN_MISSION Mission-N100

Metricas:
- idempotent_retry_total: 1
```

**Explicación:** este es el caso más importante de la sesión. La mayoría **sí** confirmó la asignación, pero el líder cayó antes de responderle al cliente, así que `LC-Norte` solo vio un timeout. El timeout es incertidumbre, no fallo. Al reintentar con la misma `K1`, el nuevo líder detecta que esa clave ya fue aplicada y devuelve el mismo resultado (`log[19]`, misma misión) sin ejecutar nada de nuevo.

El cuarto paso muestra el contraste: si el cliente hubiera reintentado con una clave nueva, el sistema lo trata como una operación distinta y lo único que lo detiene es la invariante del dron. Por eso la clave de idempotencia tiene que sobrevivir al retry, no generarse otra vez.

### 4. Sin quórum

```bash
npm run lab:consensus -- --sin-quorum
```

```text
Pasos:
- [uncommitted] LC-Norte: Mission-N100 log[19] acks=Fleet-R1 quorum-unavailable

Log de flota:
- log[18] term=8 status=AVAILABLE (committed)
- log[19] term=8 assign Mission-N100 (uncommitted)

Estado final: Drone-Alpha-1 AVAILABLE sin mision

Metricas:
- quorum_unavailable_total: 1
```

**Explicación:** una partición deja al líder aislado. La entrada existe en su log, pero con 1 de 3 réplicas no se alcanza el quórum de 2, así que **no se compromete** y el estado sigue en `AVAILABLE`. La diferencia entre `log[19] (uncommitted)` y el estado sin cambios es el punto: el sistema se degrada y responde "no confirmado", en lugar de inventar una asignación que ninguna mayoría acordó. Un `uncommitted` es una respuesta honesta; una asignación optimista sería una invariante rota.

## Campos de evidencia

Revise la salida de `--json`:

- `cluster`: réplicas, quórum, líder y término vigentes.
- `pasos[].decision`: `committed`, `rejected`, `accepted-idempotent`, `uncommitted` o `leader-elected`.
- `pasos[].reason`: `majority-ack`, `stale-leader-term`, `already-applied`, `drone-already-assigned` o `quorum-unavailable`.
- `pasos[].acks` y `quorum`: qué réplicas aceptaron y cuántas hacían falta.
- `log`: historia acordada, con `index`, `term`, `command` y si está comprometida.
- `estadoFinal`: estado del dron después de aplicar solo lo comprometido.
- `metricas`: evidencia observable de liderazgo, rechazos, reintentos y falta de quórum.
- `frontera`: límite académico explícito del laboratorio.

Texto de frontera obligatorio:

```text
Session 34 simulates Raft intuition (leader, term, replicated log, majority and commit) for academic purposes only; it does not implement real Raft/Paxos, production membership, or real failover.
```

## Checklist de defensa

- [ ] Explicar por qué el quórum solo cuenta réplicas, mientras el consenso acuerda además valor, posición y término.
- [ ] Mostrar en el log que una sola asignación quedó comprometida y que el rechazo también se registró.
- [ ] Justificar por qué un comando con `term` viejo se rechaza antes de evaluar el estado del dron.
- [ ] Explicar por qué un timeout no permite afirmar que la operación falló.
- [ ] Demostrar que el retry con la misma `Idempotency-Key` no duplica la asignación.
- [ ] Diferenciar `uncommitted` de `rejected`: uno es incertidumbre, el otro es una decisión tomada.
- [ ] Nombrar las métricas que dejan evidencia de cada protección.
- [ ] Declarar que el laboratorio no implementa Raft/Paxos real, membresía productiva ni failover real.

## No objetivos

Quedan fuera de alcance:

- implementación real de Raft o Paxos;
- elección de líder con votos, timeouts aleatorios y persistencia de estado;
- replicación por red con pérdida y reordenamiento real de mensajes;
- membresía dinámica del clúster;
- transacciones distribuidas;
- failover real de servicios;
- integración con etcd, ZooKeeper o Consul.

## Conclusión

La Sesión 34 cierra el marco técnico del curso: el consenso no evita que las réplicas fallen, pero limita qué se puede confirmar mientras fallan. Una decisión crítica de AURA se sostiene cuando el término identifica al líder vigente, la mayoría respalda la entrada del log, la clave de idempotencia protege el reintento y el sistema es capaz de responder "todavía no lo sé" en lugar de inventar un estado que nadie acordó.
