/**
 * Bounded readiness recordings reduced without access to a running Realm.
 *
 * A pending entry says where observed progress stopped; it does not establish
 * a hang. Persistent watches normally remain pending. Eviction makes absence
 * inconclusive, so every report carries an explicit incomplete-history flag.
 *
 * @internal
 */
export interface ReadinessTraceEvent {
  sequence: number;
  elapsed_us: number;
  operation: number;
  owner: number;
  ident: number;
  filter: number;
  token: number;
  stage: string;
}
export interface ReadinessTraceSnapshot {
  version: 1;
  enabled: boolean;
  capacity: number;
  sequence: number;
  dropped: number;
  events: ReadinessTraceEvent[];
}
interface Operation {
  operation: number;
  owner: number;
  ident: number;
  filter: number;
  token: number;
  lastStage: string;
  lastSequence: number;
  registered: boolean;
  terminal: boolean;
}
const terminal = new Set([
  'cancel-requested',
  'resolved',
  'cancelled',
  'replaced',
  'cancelled-owner-retired',
  'cancelled-controller-stopped',
  'registration-failed',
  'installation-failed',
  'discarded-owner-retired',
]);
/** Reduce retained evidence; a later success never erases a detected mismatch. */
export function analyzeReadiness(snapshot: ReadinessTraceSnapshot): {
  incompleteHistory: boolean;
  pending: Operation[];
  anomalies: ReadinessTraceEvent[];
} {
  if (snapshot.version !== 1) throw new Error('Unsupported readiness trace version');
  const operations = new Map<number, Operation>();
  const anomalies: ReadinessTraceEvent[] = [];
  for (const event of snapshot.events) {
    let operation = operations.get(event.operation);
    if (!operation) {
      operation = {
        operation: event.operation,
        owner: event.owner,
        ident: event.ident,
        filter: event.filter,
        token: event.token,
        lastStage: event.stage,
        lastSequence: event.sequence,
        registered: false,
        terminal: false,
      };
      operations.set(event.operation, operation);
    }
    operation.lastStage = event.stage;
    operation.lastSequence = event.sequence;
    operation.registered ||= event.stage === 'registered';
    operation.terminal ||= terminal.has(event.stage);
    if (
      event.stage === 'owner-absent-at-route' ||
      event.stage === 'resolver-generation-mismatch' ||
      event.stage.startsWith('discarded-') ||
      event.stage === 'installation-failed' ||
      event.stage === 'registration-failed'
    ) {
      anomalies.push(event);
    }
  }
  return {
    incompleteHistory: snapshot.dropped > 0,
    pending: [...operations.values()].filter((operation) => !operation.terminal),
    anomalies,
  };
}
