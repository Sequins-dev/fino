/** Tests for cluster-aware placement and loop-health realm autoscaling. */
import { describe, it } from 'fino:test/test';
import {
  PlacementReconciler,
  ReplicaAutoscaler,
  normalizeScalingPolicy
} from 'internal:orchestrator/scaling';

describe('realm scaling policy', () => {
  it('defaults to replicated with one required replica and cluster reactor capacity', (t) => {
    t.deepEqual(normalizeScalingPolicy(undefined, 6), {
      mode: 'replicated',
      min: 1,
      max: 6,
      loopDelayTargetMs: 5,
      scaleUpWindowMs: 1_000,
      scaleDownBusyRatio: .1,
      scaleDownWindowMs: 30_000
    });
  });

  it('forces bound realms to exactly one replica', (t) => {
    t.deepEqual(normalizeScalingPolicy({ mode: 'bound' }, 12), {
      mode: 'bound',
      min: 1,
      max: 1,
      loopDelayTargetMs: 5,
      scaleUpWindowMs: 1_000,
      scaleDownBusyRatio: .1,
      scaleDownWindowMs: 30_000
    });
  });

  it('rejects an availability minimum above the configured or physical maximum', (t) => {
    t.throws(() => normalizeScalingPolicy({ min: 5, max: 4 }, 8), /minimum.*maximum/i);
    t.throws(() => normalizeScalingPolicy({ min: 9 }, 8), /reactor capacity/i);
  });
});

describe('cluster placement reconciler', () => {
  const nodes = [
    { nodeId: 'local', local: true, loopPressure: .3, reactorCapacity: 2, assigned: 0 },
    { nodeId: 'remote-a', local: false, loopPressure: .3, reactorCapacity: 2, assigned: 0 },
    { nodeId: 'remote-b', local: false, loopPressure: .5, reactorCapacity: 2, assigned: 0 }
  ];

  it('prefers a remote node when its loop load is equal to local', (t) => {
    const placement = new PlacementReconciler().chooseNode(nodes, new Set());
    t.equal(placement?.nodeId, 'remote-a');
  });

  it('keeps placement local when local loop health is strictly better', (t) => {
    const placement = new PlacementReconciler().chooseNode([
      { ...nodes[0]!, loopPressure: .1 },
      nodes[1]!
    ], new Set());
    t.equal(placement?.nodeId, 'local');
  });

  it('spreads replicas to nodes without a copy before filling another reactor', (t) => {
    const placement = new PlacementReconciler().chooseNode(nodes, new Set(['local', 'remote-a']));
    t.equal(placement?.nodeId, 'remote-b');
  });

  it('rejects nodes without reactor admission capacity', (t) => {
    const placement = new PlacementReconciler().chooseNode([
      { ...nodes[0]!, assigned: 2 },
      { ...nodes[1]!, assigned: 2 }
    ], new Set());
    t.equal(placement, null);
  });
});

describe('replica autoscaler', () => {
  it('scales after one second of sustained leading loop pressure', (t) => {
    const scaler = new ReplicaAutoscaler({ min: 1, max: 4 });
    scaler.observe(0, [{ replicaId: 'r1', busyRatio: .4, queueDepth: 1, oldestQueueAgeMs: 3, runnableDelayP95Ms: 3 }]);
    t.equal(scaler.evaluate(999), null, 'stabilization window has not elapsed');
    scaler.observe(1_000, [{ replicaId: 'r1', busyRatio: .4, queueDepth: 2, oldestQueueAgeMs: 4, runnableDelayP95Ms: 3 }]);
    t.deepEqual(scaler.evaluate(1_000), { type: 'scale-up' });
  });

  it('allows only one pending scale action', (t) => {
    const scaler = new ReplicaAutoscaler({ min: 1, max: 4 });
    scaler.observe(0, [{ replicaId: 'r1', busyRatio: .5, queueDepth: 1, oldestQueueAgeMs: 3, runnableDelayP95Ms: 3 }]);
    scaler.observe(1_000, [{ replicaId: 'r1', busyRatio: .5, queueDepth: 2, oldestQueueAgeMs: 4, runnableDelayP95Ms: 3 }]);
    t.deepEqual(scaler.evaluate(1_000), { type: 'scale-up' });
    t.equal(scaler.evaluate(2_000), null, 'pending action suppresses another decision');
    scaler.completeAction();
    t.deepEqual(scaler.evaluate(2_000), { type: 'scale-up' }, 'pressure can request another replica after readiness');
  });

  it('drains one quiet replica after thirty seconds below ten percent', (t) => {
    const scaler = new ReplicaAutoscaler({ min: 1, max: 4 });
    const quiet = [
      { replicaId: 'r1', busyRatio: .05, queueDepth: 0, oldestQueueAgeMs: 0, runnableDelayP95Ms: 0 },
      { replicaId: 'r2', busyRatio: .08, queueDepth: 0, oldestQueueAgeMs: 0, runnableDelayP95Ms: 0 }
    ];
    scaler.observe(0, quiet);
    t.equal(scaler.evaluate(29_999), null);
    scaler.observe(30_000, quiet);
    t.deepEqual(scaler.evaluate(30_000), { type: 'scale-down', replicaId: 'r1' });
  });

  it('never scales a bound realm or below the availability minimum', (t) => {
    const bound = new ReplicaAutoscaler({ mode: 'bound', min: 1, max: 1 });
    bound.observe(0, [{ replicaId: 'r1', busyRatio: .9, queueDepth: 4, oldestQueueAgeMs: 20, runnableDelayP95Ms: 20 }]);
    bound.observe(1_000, [{ replicaId: 'r1', busyRatio: .9, queueDepth: 8, oldestQueueAgeMs: 30, runnableDelayP95Ms: 30 }]);
    t.equal(bound.evaluate(1_000), null);
    const minimum = new ReplicaAutoscaler({ min: 2, max: 4 });
    minimum.observe(0, [
      { replicaId: 'r1', busyRatio: 0, queueDepth: 0, oldestQueueAgeMs: 0, runnableDelayP95Ms: 0 },
      { replicaId: 'r2', busyRatio: 0, queueDepth: 0, oldestQueueAgeMs: 0, runnableDelayP95Ms: 0 }
    ]);
    minimum.observe(30_000, [
      { replicaId: 'r1', busyRatio: 0, queueDepth: 0, oldestQueueAgeMs: 0, runnableDelayP95Ms: 0 },
      { replicaId: 'r2', busyRatio: 0, queueDepth: 0, oldestQueueAgeMs: 0, runnableDelayP95Ms: 0 }
    ]);
    t.equal(minimum.evaluate(30_000), null);
  });
});
