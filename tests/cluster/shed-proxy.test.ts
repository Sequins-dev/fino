/**
 * A shed workload keeps its parent's port working.
 *
 * When a pre-init spec moves to another node, the parent keeps the local port
 * it was handed. The source node holds the spec's channel endpoints and
 * relays them, so messages and completion still reach the parent — the
 * migration is invisible above the port.
 */
import { describe, it } from 'fino:test/test';
import {
  clearSheddingWorkload,
  closeReactorQueue,
  createReactorQueue,
  createScheduledRealm,
  markSheddingWorkload,
  scheduledRealmRecv,
  scheduledRealmSend,
  shedComplete,
  shedRecvFromParent,
  shedSendToParent,
  shedWorkloadWakeFd,
  takeScheduledRealmStatus,
  takeShedWorkload,
} from 'internal:scheduler-native';
import { serialize, deserialize } from 'internal:serializer';
import { decodeEnvelope, encodeEnvelope, EnvelopeKind } from 'internal:realm/envelope';

/** `serialize` yields [payload, ...transferStores]; ports take them apart. */
const encode = (value: unknown): Uint8Array =>
  (serialize as (v: unknown) => Uint8Array[])(value)[0]!;
const decode = (value: Uint8Array): unknown =>
  (deserialize as (b: Uint8Array, s?: Uint8Array[]) => unknown)(value);
import { cwd } from 'fino:process';

const entry = `${cwd()}/tests/realm/fixtures/hello.ts`;

/**
 * Mark and take one specific spec.
 *
 * `markSheddingWorkload` picks the lowest-priority spec in the whole process
 * pool, which in a test process can belong to the runner rather than to us,
 * so marks that are not ours are cleared and retried.
 */
function takeOwn(owner: number): number | null {
  for (let attempt = 0; attempt < 16; attempt++) {
    const marked = markSheddingWorkload();
    if (marked === 0) return null;
    if (marked === owner) return takeShedWorkload(undefined, marked);
    clearSheddingWorkload(undefined, marked);
  }
  return null;
}

/**
 * Create a scheduled realm and take its spec before a reactor claims it.
 *
 * Reactors race the take, and when one wins that is the intended behavior —
 * local execution beats shedding. Retry so the proxy path, which only exists
 * for specs that did move, is what actually gets exercised.
 */
function shedFreshSpec(): { realm: ReturnType<typeof createScheduledRealm>; shed: number } | null {
  for (let attempt = 0; attempt < 25; attempt++) {
    const realm = createScheduledRealm(cwd(), entry, '[]', false, undefined, undefined, false);
    const shed = takeOwn(realm.owner);
    if (shed !== null) return { realm, shed };
  }
  return null;
}

describe('shed workload proxying', () => {
  it('relays parent traffic and completion for a workload that moved away', (t) => {
    // A queue with no reactor threads: the spec stays pre-init, exactly the
    // state in which a workload is eligible to be shed.
    const queue = createReactorQueue(false);
    const taken = shedFreshSpec();
    t.ok(taken !== null, 'a pending spec was taken off the queue');
    if (taken === null) return;
    const { realm, shed } = taken;

    t.ok(shedWorkloadWakeFd(shed) > 0, 'the relay has a wake descriptor to watch');

    // Parent -> workload: the source drains it for forwarding to the new host.
    // The envelope travels beside the payload, not inside it, so the relay can
    // classify a frame without deserializing what a remote realm sent.
    const request = encodeEnvelope({ kind: EnvelopeKind.Call, correlation: 9 });
    scheduledRealmSend(realm.handle, request, encode({ hello: 'moved realm' }));
    const forwarded = shedRecvFromParent(shed);
    t.equal(forwarded.length, 1, 'the parent message is available to forward');
    t.deepEqual(
      decode(forwarded[0]![0]![0]!),
      { hello: 'moved realm' },
      'the payload survives the proxy path intact',
    );
    t.deepEqual(
      decodeEnvelope(forwarded[0]![2]),
      { kind: EnvelopeKind.Call, correlation: 9 },
      'the envelope survives the proxy path intact',
    );

    // New host -> parent: delivered back through the local port.
    shedSendToParent(
      shed,
      encode({ reply: 'from the new host' }),
      [],
      encodeEnvelope({ kind: EnvelopeKind.CallResult, correlation: 9 }),
    );
    const received = scheduledRealmRecv(realm.handle);
    t.equal(received.length, 1, 'the parent received the remote reply');
    t.deepEqual(
      decode(received[0]![0]![0]!),
      { reply: 'from the new host' },
      'the reply payload is intact',
    );
    t.deepEqual(
      decodeEnvelope(received[0]![2]),
      { kind: EnvelopeKind.CallResult, correlation: 9 },
      'the reply is correlated back to the request the parent made',
    );

    // Remote completion settles the parent's pending run().
    t.equal(takeScheduledRealmStatus(realm.handle).kind, 'pending', 'not finished yet');
    shedComplete(shed);
    t.equal(
      takeScheduledRealmStatus(realm.handle).kind,
      'done',
      'remote completion settles the local parent',
    );

    closeReactorQueue(queue.handle);
  });

  it('reports a remote failure to the local parent', (t) => {
    const queue = createReactorQueue(false);
    const taken = shedFreshSpec();
    t.ok(taken !== null, 'a pending spec was taken off the queue');
    if (taken === null) return;
    const { realm, shed } = taken;
    shedComplete(shed, 'entry module threw on the new host');
    const status = takeScheduledRealmStatus(realm.handle);
    t.equal(status.kind, 'error', 'the parent sees a failure');
    t.ok(
      (status.error ?? '').includes('new host'),
      `the remote error message reaches the parent: ${status.error}`,
    );
    closeReactorQueue(queue.handle);
  });
});
