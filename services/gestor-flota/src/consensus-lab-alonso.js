#!/usr/bin/env node

const MODOS = [
  'commit-por-mayoria',
  'lider-viejo-rechazado',
  'retry-idempotente',
  'sin-quorum'
];

const FRONTERA =
  'Session 34 simulates Raft intuition (leader, term, replicated log, majority and commit) for academic purposes only; it does not implement real Raft/Paxos, production membership, or real failover.';

class FleetConsensusGroup {
  constructor({ replicas, leaderId, term, baseIndex }) {
    this.replicas = replicas;
    this.quorum = Math.floor(replicas.length / 2) + 1;
    this.leaderId = leaderId;
    this.term = term;
    this.log = [{ index: baseIndex, term: term, command: 'status=AVAILABLE', committed: true }];
    this.appliedKeys = new Map();
    this.state = { droneId: 'Drone-Alpha-1', status: 'AVAILABLE', missionId: null };
    this.metrics = {
      leader_changes_total: 0,
      old_leader_rejected_total: 0,
      idempotent_retry_total: 0,
      quorum_unavailable_total: 0,
      consensus_commit_latency_ms: 0
    };
  }

  nextIndex() {
    const ultimaEntrada = this.log[this.log.length - 1];
    return ultimaEntrada.index + 1;
  }

  appendEntry(command) {
    const entrada = { index: this.nextIndex(), term: this.term, command: command, committed: false };
    this.log.push(entrada);
    return entrada;
  }

  isStaleLeader(leaderId, leaderTerm) {
    return leaderTerm < this.term || leaderId !== this.leaderId;
  }

  droneAlreadyAssigned(missionId) {
    return this.state.missionId !== null && this.state.missionId !== missionId;
  }

  collectAcks(acks) {
    const aceptan = [this.leaderId];
    for (const replica of acks) {
      if (replica !== this.leaderId) {
        aceptan.push(replica);
      }
    }
    return aceptan;
  }

  electLeader(newLeaderId) {
    this.term = this.term + 1;
    this.leaderId = newLeaderId;
    this.metrics.leader_changes_total += 1;
    return { decision: 'leader-elected', actor: newLeaderId, term: this.term };
  }

  assign({ actor, leaderId, leaderTerm, missionId, idempotencyKey, acks = [], latencyMs = 0 }) {
    if (this.isStaleLeader(leaderId, leaderTerm)) {
      this.metrics.old_leader_rejected_total += 1;
      return {
        decision: 'rejected',
        reason: 'stale-leader-term',
        actor: actor,
        missionId: missionId,
        proposedTerm: leaderTerm,
        currentTerm: this.term,
        currentLeader: this.leaderId
      };
    }

    if (this.appliedKeys.has(idempotencyKey)) {
      this.metrics.idempotent_retry_total += 1;
      const anterior = this.appliedKeys.get(idempotencyKey);
      return {
        decision: 'accepted-idempotent',
        reason: 'already-applied',
        actor: actor,
        idempotencyKey: idempotencyKey,
        missionId: anterior.missionId,
        logIndex: anterior.logIndex,
        term: anterior.term,
        appliedOnce: true
      };
    }

    if (this.droneAlreadyAssigned(missionId)) {
      const rechazo = this.appendEntry(`reject ${missionId}`);
      rechazo.committed = true;
      return {
        decision: 'rejected',
        reason: 'drone-already-assigned',
        actor: actor,
        missionId: missionId,
        currentMissionId: this.state.missionId,
        logIndex: rechazo.index
      };
    }

    const entrada = this.appendEntry(`assign ${missionId}`);
    const replicasQueAceptan = this.collectAcks(acks);

    if (replicasQueAceptan.length < this.quorum) {
      this.metrics.quorum_unavailable_total += 1;
      return {
        decision: 'uncommitted',
        reason: 'quorum-unavailable',
        actor: actor,
        missionId: missionId,
        logIndex: entrada.index,
        acks: replicasQueAceptan,
        quorum: this.quorum
      };
    }

    entrada.committed = true;
    this.state.status = 'IN_MISSION';
    this.state.missionId = missionId;
    this.metrics.consensus_commit_latency_ms = latencyMs;
    this.appliedKeys.set(idempotencyKey, {
      logIndex: entrada.index,
      term: entrada.term,
      missionId: missionId
    });

    return {
      decision: 'committed',
      reason: 'majority-ack',
      actor: actor,
      missionId: missionId,
      logIndex: entrada.index,
      term: entrada.term,
      acks: replicasQueAceptan,
      quorum: this.quorum,
      appliedOnce: true
    };
  }
}

function crearGrupo() {
  return new FleetConsensusGroup({
    replicas: ['Fleet-R1', 'Fleet-R2', 'Fleet-R3'],
    leaderId: 'Fleet-R1',
    term: 8,
    baseIndex: 18
  });
}

function commitPorMayoria() {
  const grupo = crearGrupo();

  const norte = grupo.assign({
    actor: 'LC-Norte',
    leaderId: 'Fleet-R1',
    leaderTerm: 8,
    missionId: 'Mission-N100',
    idempotencyKey: 'K1',
    acks: ['Fleet-R2'],
    latencyMs: 42
  });

  const centro = grupo.assign({
    actor: 'LC-Centro',
    leaderId: 'Fleet-R1',
    leaderTerm: 8,
    missionId: 'Mission-C200',
    idempotencyKey: 'K2',
    acks: ['Fleet-R2', 'Fleet-R3']
  });

  return {
    modo: 'commit-por-mayoria',
    descripcion: 'Dos solicitudes compiten por Drone-Alpha-1 y la mayoria confirma una sola historia.',
    grupo: grupo,
    pasos: [norte, centro],
    interpretacion:
      'La mayoria (2 de 3) confirma log[19] con Mission-N100. La segunda solicitud no se descarta en silencio: queda como rechazo en log[20], por eso las tres replicas cuentan la misma historia.'
  };
}

function liderViejoRechazado() {
  const grupo = crearGrupo();

  const eleccion = grupo.electLeader('Fleet-R2');

  const liderViejo = grupo.assign({
    actor: 'Fleet-R1-old-leader',
    leaderId: 'Fleet-R1',
    leaderTerm: 8,
    missionId: 'Mission-N100',
    idempotencyKey: 'K1',
    acks: ['Fleet-R3']
  });

  const liderVigente = grupo.assign({
    actor: 'LC-Norte',
    leaderId: 'Fleet-R2',
    leaderTerm: 9,
    missionId: 'Mission-N100',
    idempotencyKey: 'K1',
    acks: ['Fleet-R3'],
    latencyMs: 65
  });

  return {
    modo: 'lider-viejo-rechazado',
    descripcion: 'Fleet-R1 cae, Fleet-R2 gana la eleccion con term=9 y el lider viejo intenta seguir coordinando.',
    grupo: grupo,
    pasos: [eleccion, liderViejo, liderVigente],
    interpretacion:
      'El comando de Fleet-R1 llega con term=8 y se rechaza sin tocar el estado. Solo el lider del term vigente puede confirmar la asignacion.'
  };
}

function retryIdempotente() {
  const grupo = crearGrupo();

  const primerIntento = grupo.assign({
    actor: 'LC-Norte (respuesta perdida por timeout)',
    leaderId: 'Fleet-R1',
    leaderTerm: 8,
    missionId: 'Mission-N100',
    idempotencyKey: 'K1',
    acks: ['Fleet-R2'],
    latencyMs: 58
  });

  const eleccion = grupo.electLeader('Fleet-R2');

  const retryMismaKey = grupo.assign({
    actor: 'LC-Norte (retry con misma key K1)',
    leaderId: 'Fleet-R2',
    leaderTerm: 9,
    missionId: 'Mission-N100',
    idempotencyKey: 'K1',
    acks: ['Fleet-R3']
  });

  const retryKeyNueva = grupo.assign({
    actor: 'LC-Norte (retry con key nueva K9)',
    leaderId: 'Fleet-R2',
    leaderTerm: 9,
    missionId: 'Mission-N101',
    idempotencyKey: 'K9',
    acks: ['Fleet-R3']
  });

  return {
    modo: 'retry-idempotente',
    descripcion: 'El cliente ve timeout aunque la mayoria ya habia confirmado la entrada, y reintenta.',
    grupo: grupo,
    pasos: [primerIntento, eleccion, retryMismaKey, retryKeyNueva],
    interpretacion:
      'El timeout es incertidumbre, no fallo. Con la misma K1 el retry devuelve el resultado ya aplicado; con una clave nueva el pedido se trata como otra operacion y solo lo detiene la invariante del dron.'
  };
}

function sinQuorum() {
  const grupo = crearGrupo();

  const intento = grupo.assign({
    actor: 'LC-Norte',
    leaderId: 'Fleet-R1',
    leaderTerm: 8,
    missionId: 'Mission-N100',
    idempotencyKey: 'K1',
    acks: []
  });

  return {
    modo: 'sin-quorum',
    descripcion: 'Fleet-R2 y Fleet-R3 quedan aislados: el lider tiene la entrada en su log pero nadie mas la confirma.',
    grupo: grupo,
    pasos: [intento],
    interpretacion:
      'La entrada existe en log[19] pero no esta comprometida y el estado sigue en AVAILABLE. Sin mayoria el sistema se degrada, pero no inventa una asignacion que nadie acordo.'
  };
}

const ESCENARIOS = {
  'commit-por-mayoria': commitPorMayoria,
  'lider-viejo-rechazado': liderViejoRechazado,
  'retry-idempotente': retryIdempotente,
  'sin-quorum': sinQuorum
};

function ejecutarLab(modo) {
  const escenario = ESCENARIOS[modo];
  if (!escenario) {
    throw new Error(`Modo no valido: ${modo}. Modos disponibles: ${MODOS.join(', ')}`);
  }

  const resultado = escenario();
  const grupo = resultado.grupo;

  return {
    modo: resultado.modo,
    descripcion: resultado.descripcion,
    pasos: resultado.pasos,
    cluster: {
      replicas: grupo.replicas,
      quorum: grupo.quorum,
      leaderId: grupo.leaderId,
      term: grupo.term
    },
    log: grupo.log,
    estadoFinal: grupo.state,
    metricas: grupo.metrics,
    interpretacion: resultado.interpretacion,
    frontera: FRONTERA
  };
}

function parseArgs(argv) {
  const options = { modo: 'commit-por-mayoria', json: false };

  for (const arg of argv) {
    if (arg === '--json') {
      options.json = true;
    } else if (arg.startsWith('--modo=')) {
      options.modo = arg.split('=')[1];
    } else if (arg.startsWith('--')) {
      options.modo = arg.slice(2);
    }
  }

  return options;
}

function describirPaso(paso) {
  let detalle = '';
  if (paso.missionId) {
    detalle = detalle + ` ${paso.missionId}`;
  }
  if (paso.logIndex !== undefined) {
    detalle = detalle + ` log[${paso.logIndex}]`;
  }
  if (paso.term !== undefined) {
    detalle = detalle + ` term=${paso.term}`;
  }
  if (paso.acks) {
    detalle = detalle + ` acks=${paso.acks.join('+')}`;
  }
  if (paso.reason) {
    detalle = detalle + ` ${paso.reason}`;
  }
  return detalle;
}

function imprimirReporte(reporte) {
  console.log(`Laboratorio Sesion 34 - Consenso distribuido: ${reporte.modo}`);
  console.log(reporte.descripcion);
  console.log(
    `Cluster: N=${reporte.cluster.replicas.length} quorum=${reporte.cluster.quorum} lider=${reporte.cluster.leaderId} term=${reporte.cluster.term}`
  );

  console.log('\nPasos:');
  for (const paso of reporte.pasos) {
    console.log(`- [${paso.decision}] ${paso.actor}:${describirPaso(paso)}`);
  }

  console.log('\nLog de flota:');
  for (const entrada of reporte.log) {
    const estado = entrada.committed ? 'committed' : 'uncommitted';
    console.log(`- log[${entrada.index}] term=${entrada.term} ${entrada.command} (${estado})`);
  }

  const mision = reporte.estadoFinal.missionId || 'sin mision';
  console.log(`\nEstado final: ${reporte.estadoFinal.droneId} ${reporte.estadoFinal.status} ${mision}`);

  console.log('\nMetricas:');
  for (const nombre of Object.keys(reporte.metricas)) {
    console.log(`- ${nombre}: ${reporte.metricas[nombre]}`);
  }

  console.log(`\nInterpretacion: ${reporte.interpretacion}`);
  console.log(`Frontera: ${reporte.frontera}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const reporte = ejecutarLab(options.modo);

  if (options.json) {
    console.log(JSON.stringify(reporte, null, 2));
    return;
  }

  imprimirReporte(reporte);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { FleetConsensusGroup, MODOS, ejecutarLab, parseArgs };
