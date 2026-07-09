/**
* Tests for OTel topic emission from fino:realm and fino:realm/pool.
*
* The topics are gated on hasSubscribers, so they only fire when a subscriber
* is registered before the action takes place.  These tests subscribe first,
* perform the action, then assert the expected events arrived.
*/
import { describe, it } from 'fino:test/test';
import { topic } from 'fino:context/topic';
import { Realm } from 'fino:realm';
import { RealmPool } from 'fino:realm/pool';
import type echoFn from '../realm/fixtures/echo-fn.ts';
import type sumFn from '../realm/fixtures/sum-fn.ts';
import type errorFn from '../realm/fixtures/error-fn.ts';
// Topic name format: otel:runtime:<domain>:<operation>:<phase>
const T_REALM_SPAWN = 'otel:runtime:realm:spawn:start';
const T_REALM_CALL = 'otel:runtime:realm:call:start';
const T_REALM_END = 'otel:runtime:realm:call:end';
const T_POOL_CALL = 'otel:runtime:realm_pool:call:start';
const T_POOL_CALL_END = 'otel:runtime:realm_pool:call:end';
// ---------------------------------------------------------------------------
// Realm lifecycle topics
// ---------------------------------------------------------------------------
describe('Realm OTel topics', () => {
  it('fino.realm.spawn.start fires when a realm is allocated', (t) => {
    const spawnTopic = topic(T_REALM_SPAWN);
    const iter = spawnTopic[Symbol.asyncIterator]();
    const pending = iter.next();
    const realm = new Realm({
      entry: new URL('../realm/fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    return pending.then((ev) => {
      iter.return!();
      const data = ev.value as {
        kind?: string;
        entry?: string;
      };
      t.ok(data.kind === 'pool' || data.kind === 'thread', `kind is an allocation outcome (got ${data.kind})`);
      t.ok(typeof data.entry === 'string' && data.entry.length > 0, 'entry path included');
      realm.terminate();
      realm.port.close();
    });
  });
  it('fino.realm.call.start fires when call() is invoked', async (t) => {
    const callTopic = topic(T_REALM_CALL);
    const iter = callTopic[Symbol.asyncIterator]();
    const realm = new Realm<typeof echoFn>({
      entry: new URL('../realm/fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    const pendingEvent = iter.next();
    const result = await realm.call('hello');
    const ev = await pendingEvent;
    iter.return!();
    t.equal(result, 'hello', 'call returned correct result');
    const data = ev.value as {
      kind?: string;
      topic?: string;
      domain?: string;
      operation?: string;
      phase?: string;
    };
    t.ok(data.kind === 'pool' || data.kind === 'thread', 'kind is an allocation outcome');
    t.equal(data.topic, T_REALM_CALL, 'event.topic matches subscription name');
    t.equal(data.domain, 'realm', 'event.domain is "realm"');
    t.equal(data.operation, 'call', 'event.operation is "call"');
    t.equal(data.phase, 'start', 'event.phase is "start"');
  });
  it('fino.realm.call.end fires after call() resolves', async (t) => {
    const endTopic = topic(T_REALM_END);
    const iter = endTopic[Symbol.asyncIterator]();
    const realm = new Realm<typeof echoFn>({
      entry: new URL('../realm/fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    const pendingEnd = iter.next();
    await realm.call('world');
    const ev = await pendingEnd;
    iter.return!();
    const data = ev.value as {
      kind?: string;
      durationMs?: number;
      topic?: string;
      phase?: string;
    };
    t.ok(data.kind === 'pool' || data.kind === 'thread', 'kind is an allocation outcome');
    t.ok(typeof data.durationMs === 'number' && data.durationMs >= 0, 'durationMs is non-negative');
    t.equal(data.topic, T_REALM_END, 'end event.topic matches');
    t.equal(data.phase, 'end', 'end event.phase is "end"');
  });
  it('fino.realm.call.end fires with error:true when call() rejects', async (t) => {
    const endTopic = topic(T_REALM_END);
    const iter = endTopic[Symbol.asyncIterator]();
    const realm = new Realm<typeof errorFn>({
      entry: new URL('../realm/fixtures/error-fn.ts', import.meta.url).pathname,
    });
    const pendingEnd = iter.next();
    try {
      await realm.call('trigger');
    } catch {}
    const ev = await pendingEnd;
    iter.return!();
    const data = ev.value as {
      error?: boolean;
      durationMs?: number;
    };
    t.ok(data.error === true, 'end event has error:true on rejection');
    t.ok(typeof data.durationMs === 'number' && data.durationMs >= 0, 'durationMs present');
  });
});
// ---------------------------------------------------------------------------
// RealmPool topics
// ---------------------------------------------------------------------------
describe('RealmPool OTel topics', () => {
  it('fino.realm_pool.call.start fires for each pool.call()', async (t) => {
    const callTopic = topic(T_POOL_CALL);
    const iter = callTopic[Symbol.asyncIterator]();
    const pool = new RealmPool<typeof sumFn>({
      entry: new URL('../realm/fixtures/sum-fn.ts', import.meta.url).pathname,
      size: 1
    });
    const pendingEvent = iter.next();
    const result = await pool.call(3, 4);
    const ev = await pendingEvent;
    iter.return!();
    t.equal(result, 7, 'pool.call returned correct result');
    const data = ev.value as {
      correlationId?: number;
      poolSize?: number;
      topic?: string;
      domain?: string;
      operation?: string;
      phase?: string;
    };
    t.ok(typeof data.correlationId === 'number', 'correlationId in event');
    t.equal(data.poolSize, 1, 'poolSize matches');
    t.equal(data.topic, T_POOL_CALL, 'event.topic matches subscription name');
    t.equal(data.domain, 'realm_pool', 'event.domain is "realm_pool"');
    t.equal(data.phase, 'start', 'event.phase is "start"');
    await pool.close();
  });
  it('fino.realm_pool.call.end fires after pool.call() resolves', async (t) => {
    const endTopic = topic(T_POOL_CALL_END);
    const iter = endTopic[Symbol.asyncIterator]();
    const pool = new RealmPool<typeof sumFn>({
      entry: new URL('../realm/fixtures/sum-fn.ts', import.meta.url).pathname,
      size: 1
    });
    const pendingEnd = iter.next();
    await pool.call(10, 20);
    const ev = await pendingEnd;
    iter.return!();
    const data = ev.value as {
      correlationId?: number;
      durationMs?: number;
    };
    t.ok(typeof data.correlationId === 'number', 'correlationId in end event');
    t.ok(typeof data.durationMs === 'number' && data.durationMs >= 0, 'durationMs is non-negative');
    await pool.close();
  });
  it('fino.realm_pool.call.end fires with error:true when pool.call() rejects', async (t) => {
    const endTopic = topic(T_POOL_CALL_END);
    const iter = endTopic[Symbol.asyncIterator]();
    const pool = new RealmPool<typeof errorFn>({
      entry: new URL('../realm/fixtures/error-fn.ts', import.meta.url).pathname,
      size: 1
    });
    const pendingEnd = iter.next();
    try {
      await pool.call('trigger');
    } catch {}
    const ev = await pendingEnd;
    iter.return!();
    const data = ev.value as {
      error?: boolean;
      durationMs?: number;
    };
    t.ok(data.error === true, 'end event has error:true on worker rejection');
    t.ok(typeof data.durationMs === 'number' && data.durationMs >= 0, 'durationMs present');
    await pool.close();
  });
});
