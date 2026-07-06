/**
* Tests for the tenant workload record and its state machine.
*/
import { describe, it } from 'fino:test/test';
import { LEGAL_TRANSITIONS, canTransition, transition, createWorkloadRecord, isTerminal, workloadStatusFor, noteWake } from 'internal:scheduler/workload';

type TenantWorkloadState =
  | 'unclaimed' | 'claimed' | 'idle' | 'runnable' | 'running'
  | 'draining' | 'handoff_ready' | 'failed' | 'terminating' | 'dead';

const ALL_STATES: TenantWorkloadState[] = [
  'unclaimed', 'claimed', 'idle', 'runnable', 'running', 'draining', 'handoff_ready', 'failed', 'terminating', 'dead'
];

function record(state: TenantWorkloadState) {
  const r = createWorkloadRecord({ tenantId: 't', workloadId: 'w', isolateId: 'i' });
  r.state = state;
  return r;
}

describe('workload state machine', () => {
  it('creates an unclaimed record with sensible defaults', (t) => {
    const r = createWorkloadRecord({ tenantId: 'acme', workloadId: 'w1', isolateId: 'iso1' });
    t.equal(r.state, 'unclaimed');
    t.equal(r.priority, 'service');
    t.equal(r.threadId, null);
    t.equal(r.budget.debtMicros, 0);
    t.equal(r.lastPumpResult, null);
  });

  it('accepts every declared legal transition', (t) => {
    for (const from of ALL_STATES) {
      for (const to of LEGAL_TRANSITIONS[from]) {
        const r = record(from);
        transition(r, to);
        t.equal(r.state, to, `${from} -> ${to} applied`);
      }
    }
  });

  it('rejects every transition not declared legal, without mutating', (t) => {
    for (const from of ALL_STATES) {
      const legal = new Set(LEGAL_TRANSITIONS[from]);
      for (const to of ALL_STATES) {
        if (legal.has(to)) continue;
        const r = record(from);
        t.throws(() => transition(r, to), /illegal workload transition/, `${from} -> ${to} rejected`);
        t.equal(r.state, from, `${from} unchanged after illegal ${to}`);
      }
    }
  });

  it('drives a full claim -> run -> drain -> handoff -> reclaim lifecycle', (t) => {
    const r = record('unclaimed');
    for (const next of ['claimed', 'idle', 'runnable', 'running', 'draining', 'handoff_ready', 'claimed'] as TenantWorkloadState[]) {
      t.equal(canTransition(r.state, next), true, `${r.state} -> ${next}`);
      transition(r, next);
    }
    t.equal(r.state, 'claimed');
  });

  it('drives a failure -> terminate -> dead path to a terminal state', (t) => {
    const r = record('running');
    transition(r, 'failed');
    transition(r, 'terminating');
    transition(r, 'dead');
    t.equal(isTerminal(r.state), true);
    t.equal(LEGAL_TRANSITIONS.dead.length, 0, 'dead has no successors');
  });

  it('maps scheduler states onto coarse orchestrator status', (t) => {
    t.equal(workloadStatusFor('running'), 'running');
    t.equal(workloadStatusFor('idle'), 'running');
    t.equal(workloadStatusFor('failed'), 'error');
    t.equal(workloadStatusFor('terminating'), 'terminated');
    t.equal(workloadStatusFor('dead'), 'terminated');
  });

  it('records wakes and bumps counters', (t) => {
    const r = record('idle');
    noteWake(r, { workloadId: 'w', reason: 'io', sourceId: 's' });
    t.equal(r.runnableReasons.length, 1);
    t.equal(r.counters.recentWakeCount, 1);
  });
});
