# Guía de defensa — Examen final (Sesiones 32 y 34)

Este documento es para mí, no para entregar. Es el resumen de qué hice, por qué lo hice así, y qué respondo si me preguntan.

## Lo que entregué, en 30 segundos

Tres cosas:

1. **Plan de la Sesión 32** — qué modelo de consistencia usa cada operación de AURA (fuerte, eventual o causal).
2. **Plan de la Sesión 34** — qué decisiones de AURA necesitan consenso, y cómo se acepta o rechaza una escritura crítica.
3. **Laboratorio de la Sesión 34** — un script en `services/gestor-flota/src/consensus-lab-alonso.js` con 4 escenarios que se ejecutan y muestran las decisiones.

La conexión entre los dos planes: la Sesión 32 responde *"¿qué lectura puedo aceptar?"* y la 34 responde *"¿cómo acuerdan las réplicas una escritura antes de confirmarla?"*. Son preguntas distintas y por eso son dos planes.

---

## Parte 1 — Plan Sesión 32 (consistencia)

### La idea en una frase

**Fuerte para decidir, eventual para observar, causal para explicar.**

### Por qué no elegí un modelo único

Porque la consistencia no es una propiedad del sistema, es una decisión **por operación**. Si pongo consistencia fuerte en todo, el dashboard tiene que golpear el primario cada vez que refresca y pierdo escalabilidad sin ganar nada de seguridad. Si pongo eventual en todo, en algún momento dos operadores asignan el mismo dron porque los dos vieron "AVAILABLE" en una réplica atrasada.

La regla que puse en el plan es: **la consistencia correcta es la mínima que protege la operación**.

### La frase que resume mi criterio

*"El dashboard informa, pero el backend decide."*

Si el operador ve un dron disponible en pantalla y aprieta "Asignar", el sistema **no confía en esa vista**. Vuelve a validar contra `gestor-flota`. La vista puede estar atrasada 4 segundos y eso está bien — lo que no está bien es decidir con ella.

### Si me preguntan...

**"¿El dashboard está mal por mostrar un dato viejo?"**
No. El dashboard está cumpliendo su función, que es informar rápido. Lo que estaría mal es usar esa lectura para habilitar una acción crítica. Por eso muestro `dataAgeMs` — para que el operador sepa qué tan viejo es lo que está viendo.

**"¿Consistencia causal es lo mismo que orden cronológico?"**
No, y esta es la confusión más común. Causal no significa "en orden de reloj", significa que **si A causó B, nadie puede ver B sin poder ver A**. Dos eventos que no tienen relación causal pueden verse en cualquier orden y no pasa nada. Por eso los eventos llevan `causedBy` y `correlationId` y no me apoyo en el timestamp.

**"¿Por qué agregaste `dashboard_data_age_ms` si ya tenías `replica_lag_ms`?"**
Porque miden cosas distintas. El `replica_lag_ms` es cuánto está atrasada la réplica respecto al primario — es una métrica de infraestructura. El `dashboard_data_age_ms` es la edad del dato que efectivamente está en la pantalla del operador, que incluye además el caché del frontend y el intervalo de refresco. Puedo tener lag bajo y aun así mostrar un dato viejo.

---

## Parte 2 — Plan Sesión 34 (consenso)

### La idea en una frase

**El consenso no evita que las réplicas fallen; limita qué se puede confirmar mientras fallan.**

### La distinción que más cae en examen: quórum ≠ consenso

- **Quórum** solo cuenta: *¿cuántas réplicas respondieron?* Con N=3, mayoría = 2.
- **Consenso** acuerda además: *¿qué valor se eligió? ¿en qué posición del log? ¿con qué término? ¿está comprometido?*

Contar respuestas no alcanza cuando hay dos operaciones concurrentes. Si `LC-Norte` y `LC-Centro` piden el mismo dron y cada uno junta 2 ACKs de réplicas distintas, tengo dos "mayorías" y dos historias incompatibles. Lo que evita eso es que las mayorías se **solapan** (siempre comparten al menos un nodo) y ese nodo recuerda lo que ya aceptó. Esa es la intuición de Paxos.

### Cuándo AURA necesita consenso y cuándo no

Necesita: asignación de dron, líder vigente de flota, bloqueo por mantenimiento, log de eventos críticos, rechazo de líder viejo.

No necesita: dashboard, telemetría histórica, reportes, métricas agregadas. Ahí el consenso solo agrega latencia.

El criterio: **¿confirmar dos decisiones distintas sería inaceptable, y reconciliar después no alcanza?** Si sí, necesito acuerdo.

### Lo más importante que puedo decir sobre implementación

**AURA no debería escribir su propio protocolo de consenso.** La decisión profesional es consumirlo de etcd, ZooKeeper, Consul o una base distribuida. Pero aunque el consenso lo dé etcd, `gestor-flota` **igual** tiene que validar término, mayoría e idempotencia antes de persistir. La herramienta no me exime de validar en el recurso protegido.

---

## Parte 3 — El código, explicado

Archivo: `services/gestor-flota/src/consensus-lab-alonso.js`

### Por qué está en `gestor-flota` y no en `centro-logistica`

Porque el estado crítico replicado (el log de la flota, quién es el líder, qué término corre) es de flota. `centro-logistica` es el **cliente** que pide la asignación, no el dueño del dato.

### La clase `FleetConsensusGroup`

Simula el grupo de 3 réplicas. Lo que guarda:

- `replicas` y `quorum` — el quórum sale de `Math.floor(3 / 2) + 1 = 2`.
- `term` y `leaderId` — quién manda y con qué autoridad.
- `log` — la historia acordada. Cada entrada tiene `index`, `term`, `command` y si está `committed`.
- `appliedKeys` — el Map de `Idempotency-Key` a resultado, para que un retry no duplique.
- `state` — el estado del dron, que solo cambia cuando algo se compromete.
- `metrics` — evidencia observable.

### El método `assign()` y sus 5 validaciones, en orden

Este es el corazón y el orden **no es casual**:

**1. `isStaleLeader` — término viejo → `stale-leader-term`**
Va primero porque un líder viejo no tiene derecho ni a consultar el estado. Si `Fleet-R1` vuelve con `term=8` cuando el grupo ya está en 9, se rechaza y punto. Esto es lo que evita el split-brain.

**2. Idempotencia — clave ya aplicada → `accepted-idempotent`**
Va **antes** que la invariante del dron, y esto lo puedo defender: si lo pusiera después, un retry legítimo de la misma misión chocaría contra "el dron ya está asignado" y le devolvería un error al cliente por una operación que en realidad **sí funcionó**. El cliente vería un fallo falso.

**3. `droneAlreadyAssigned` — otra misión activa → `drone-already-assigned`**
Es la invariante de negocio: un dron no puede tener dos misiones. Y acá hago algo que viene directo de la teoría: **el rechazo también se escribe en el log**. En el material aparece como `log[20] reject C200`. La razón es que las tres réplicas tienen que contar la misma historia, incluyendo lo que se rechazó.

**4. Mayoría — sin quórum → `uncommitted`**
La entrada se agrega al log pero **sin comprometer**. Si solo el líder la tiene (1 de 3), no llego a 2 y no hay commit.

**5. Commit — recién acá cambia el estado**
Y cambia una sola vez. Se guarda la clave de idempotencia con el resultado.

### Los 4 modos

| Comando | Qué demuestra |
|---|---|
| `--commit-por-mayoria` | La mayoría confirma N100 en `log[19]`; C200 queda rechazada en `log[20]` |
| `--lider-viejo-rechazado` | R1 vuelve con `term=8`, el grupo está en 9, se rechaza sin tocar el estado |
| `--retry-idempotente` | Timeout ≠ fallo. Misma `K1` devuelve el resultado anterior; clave nueva se trata como otra operación |
| `--sin-quorum` | 1 de 3 réplicas: `log[19] uncommitted` y el dron sigue en `AVAILABLE` |

### El modo más importante es `retry-idempotente`

Si el profesor me pregunta cuál explico, elijo ese. La secuencia es: la mayoría **sí** confirmó la asignación, pero el líder cayó antes de responderle al cliente. `LC-Norte` solo vio un timeout.

**El timeout no me dice si la operación se aplicó o no.** Solo me dice que no recibí respuesta. Si asumo que falló y reintento con una clave nueva, duplico. Si reintento con la misma `K1`, el nuevo líder ve que ya la aplicó y me devuelve el mismo resultado.

El cuarto paso de ese modo muestra el contraste a propósito: con clave nueva `K9`, el sistema lo trata como una operación distinta y lo único que lo frena es la invariante del dron. Por eso la clave tiene que **sobrevivir al retry**, no generarse de nuevo.

### La diferencia entre `uncommitted` y `rejected`

Esto lo pueden preguntar y suena parecido pero no lo es:

- `rejected` es una **decisión tomada**: sé que no procede y sé por qué.
- `uncommitted` es **incertidumbre**: no pude confirmar, pero tampoco sé que falló.

Responder "no confirmado" es honesto. Aplicar la asignación igual sería inventar un estado que ninguna mayoría acordó.

---

## Parte 4 — Preguntas difíciles

**"¿Esto es Raft?"**
No, y lo digo antes de que me lo digan. Es la **intuición** de Raft: líder, término, log replicado, mayoría y commit. Le falta todo lo demás: elección real con votos y timeouts aleatorios, `AppendEntries` por red, persistencia en disco, comparación de logs entre candidatos, y resolución de entradas huérfanas. Las réplicas acá son objetos en memoria. Eso está declarado en el texto de frontera del laboratorio.

**"¿Por qué quórum 2 con N=3? ¿Y si fueran 4 réplicas?"**
Con N=3 la mayoría es 2 y tolero 1 caída. Con N=4 la mayoría sería 3 y **sigo tolerando solo 1 caída** — necesito más ACKs para el mismo nivel de tolerancia. Por eso los grupos de consenso usan números impares.

**"En `sin-quorum`, ¿esa entrada queda ahí para siempre?"**
En mi simulación sí, y es una limitación que reconozco. En Raft real el siguiente líder resuelve esa entrada: si llegó a mayoría la replica y la compromete, y si no, la sobrescribe. Yo no implementé esa reconciliación.

**"¿El log crece infinito?"**
En mi simulación sí porque es un array en memoria. En un sistema real se resuelve con snapshots y compactación de log. No lo implementé.

**"¿Por qué el rechazo va al log y no simplemente devuelves un error?"**
Porque si solo devuelvo el error al cliente, las réplicas que no participaron nunca se enteran de que hubo una segunda solicitud. Al escribirlo, la historia queda completa y cualquier réplica que se ponga al día ve la misma secuencia de hechos. Esto además sirve para auditoría.

**"¿Cómo se conecta esto con la Sesión 32?"**
La 32 me dice que la asignación necesita consistencia fuerte. La 34 me dice **cómo** se consigue esa consistencia fuerte cuando el dato está replicado: con un líder que ordena, un log y una mayoría que confirma. Sin consenso, "consistencia fuerte" en un sistema replicado es solo una intención.

---

## Parte 5 — Lo que NO debo decir

- No decir que el timestamp físico prueba el orden de los eventos.
- No decir que `suspected` es lo mismo que `dead`.
- No decir que implementé Raft o Paxos.
- No decir que el consenso "garantiza que no haya fallas". Garantiza que no se confirmen decisiones incompatibles.
- No recomendar etcd o ZooKeeper sin decir qué garantía aportan y qué cuestan.
- No decir que la consistencia fuerte siempre es mejor. La insuficiente es peligrosa; la excesiva es cara.

## Comandos, por si me piden demostrarlo

```bash
cd services/gestor-flota && npm run lab:consensus -- --retry-idempotente
```

Los otros modos: `--commit-por-mayoria`, `--lider-viejo-rechazado`, `--sin-quorum`. Agregar `--json` para la salida estructurada completa.
