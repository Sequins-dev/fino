/**
* Tests for fino:context and fino:topic.
*/
import { describe, it } from 'fino:test/test';
import { Context, Snapshot, snapshotAll } from 'fino:context';
import { topic, Topic, SubscriptionHandle, BindingHandle } from 'fino:context/topic';
import { DiskFileSystem } from 'fino:file';
describe('Context basics', () => {
  it('Context — get() returns undefined when no value set', (t) => {
    const ctx = new Context('test');
    t.equal(ctx.get(), undefined, 'undefined by default');
  });
  it('Context — name accessor', (t) => {
    const ctx = new Context('myCtx');
    t.equal(ctx.name, 'myCtx', 'name matches');
  });
  it('Multiple contexts are independent', (t) => {
    const a = new Context('a');
    const b = new Context('b');
    a.runWithValue('a-value', () => {
      t.equal(a.get(), 'a-value', 'a set');
      t.equal(b.get(), undefined, 'b unchanged');
      b.runWithValue('b-value', () => {
        t.equal(a.get(), 'a-value', 'a still set inside b scope');
        t.equal(b.get(), 'b-value', 'b set');
      });
      t.equal(b.get(), undefined, 'b restored');
    });
  });
});
describe('runWithValue', () => {
  it('Context — runWithValue sets value inside fn', (t) => {
    const ctx = new Context('sync');
    ctx.runWithValue('hello', () => {
      t.equal(ctx.get(), 'hello', 'value inside runWithValue');
    });
  });
  it('Context — runWithValue restores previous value after fn returns', (t) => {
    const ctx = new Context('restore');
    ctx.runWithValue('inner', () => {});
    t.equal(ctx.get(), undefined, 'restored to undefined');
  });
  it('Context — runWithValue restores value even when fn throws', (t) => {
    const ctx = new Context('throw-restore');
    try {
      ctx.runWithValue('inner', () => {
        throw new Error('boom');
      });
    } catch (_) {}
    t.equal(ctx.get(), undefined, 'restored after throw');
  });
  it('Context — nested runWithValue scopes are independent', (t) => {
    const ctx = new Context('nested');
    ctx.runWithValue('middle', () => {
      t.equal(ctx.get(), 'middle', 'inner value');
      ctx.runWithValue('inner', () => {
        t.equal(ctx.get(), 'inner', 'deepest value');
      });
      t.equal(ctx.get(), 'middle', 'restored to middle');
    });
    t.equal(ctx.get(), undefined, 'restored to undefined');
  });
  it('Context — runWithValue returns fn return value', (t) => {
    const ctx = new Context('return-val');
    const result = ctx.runWithValue('x', () => 42);
    t.equal(result, 42, 'returns fn result');
  });
});
describe('runClear', () => {
  it('Context — runClear hides outer value', (t) => {
    const ctx = new Context('clear');
    ctx.runWithValue('outer', () => {
      ctx.runClear(() => {
        t.equal(ctx.get(), undefined, 'cleared inside runClear');
      });
      t.equal(ctx.get(), 'outer', 'outer value restored');
    });
  });
  it('Context — runClear restores after throw', (t) => {
    const ctx = new Context('clear-throw');
    ctx.runWithValue('outer', () => {
      try {
        ctx.runClear(() => {
          throw new Error();
        });
      } catch (_) {}
      t.equal(ctx.get(), 'outer', 'outer restored after throw in runClear');
    });
  });
});
describe('async propagation', () => {
  it('Context — value propagates through await', async (t) => {
    const ctx = new Context('async-prop');
    await ctx.runWithValue('propagated', async () => {
      await Promise.resolve();
      t.equal(ctx.get(), 'propagated', 'value survives await');
    });
  });
  it('Context — value propagates through .then()', async (t) => {
    const ctx = new Context('then-prop');
    let captured;
    await ctx.runWithValue('via-then', () => Promise.resolve().then(() => {
      captured = ctx.get();
    }));
    t.equal(captured, 'via-then', 'value propagated through .then()');
  });
  it('Context — nested awaits all see the right value', async (t) => {
    const ctx = new Context('nested-await');
    await ctx.runWithValue('deep', async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      t.equal(ctx.get(), 'deep', 'survives multiple awaits');
    });
  });
  it('Context — independent async scopes do not bleed', async (t) => {
    const ctx = new Context('no-bleed');
    const results: Array<{
      who: string;
      val: unknown;
    }> = [];
    const runA = ctx.runWithValue('A', async () => {
      await Promise.resolve();
      results.push({
        who: 'A',
        val: ctx.get()
      });
    });
    const runB = ctx.runWithValue('B', async () => {
      await Promise.resolve();
      results.push({
        who: 'B',
        val: ctx.get()
      });
    });
    await Promise.all([runA, runB]);
    t.equal(results.find((r) => r.who === 'A')!.val, 'A', 'A scope correct');
    t.equal(results.find((r) => r.who === 'B')!.val, 'B', 'B scope correct');
  });
  it('Context — value propagates through queueMicrotask', async (t) => {
    const ctx = new Context('microtask-prop');
    let seen: unknown;
    await new Promise<void>((resolve) => {
      ctx.runWithValue('via-microtask', () => {
        queueMicrotask(() => {
          seen = ctx.get();
          resolve();
        });
      });
    });
    t.equal(seen, 'via-microtask', 'microtask callback sees scheduling context');
  });
  it('Context — value propagates through setTimeout', async (t) => {
    const ctx = new Context('timeout-prop');
    let seen: unknown;
    await new Promise<void>((resolve) => {
      ctx.runWithValue('via-timeout', () => {
        setTimeout(() => {
          seen = ctx.get();
          resolve();
        }, 0);
      });
    });
    t.equal(seen, 'via-timeout', 'timer callback sees scheduling context');
  });
  it('Context — value propagates through setInterval', async (t) => {
    const ctx = new Context('interval-prop');
    let seen: unknown;
    await new Promise<void>((resolve) => {
      ctx.runWithValue('via-interval', () => {
        const id = setInterval(() => {
          seen = ctx.get();
          clearInterval(id);
          resolve();
        }, 0);
      });
    });
    t.equal(seen, 'via-interval', 'interval callback sees scheduling context');
  });
  it('Context — dispatchEvent listeners see the current dispatch context', (t) => {
    const ctx = new Context('eventtarget-dispatch-prop');
    const target = new EventTarget();
    let seen: unknown;
    target.addEventListener('release-contract', () => {
      seen = ctx.get();
    });
    ctx.runWithValue('via-dispatch', () => {
      target.dispatchEvent(new Event('release-contract'));
    });
    t.equal(seen, 'via-dispatch', 'listener sees context active during dispatch');
  });
  it('Context — value propagates through Promise-based file I/O continuations', async (t) => {
    const ctx = new Context('file-io-prop');
    const fs = new DiskFileSystem();
    const path = `/tmp/fino-context-prop-${Date.now()}-${Math.random()}.txt`;
    let seen: unknown;
    await fs.writeFile(path, 'context');
    await ctx.runWithValue('via-file-io', async () => {
      const contents = await fs.readFile(path);
      seen = ctx.get();
      t.equal(contents, 'context', 'file read completed');
    });
    t.equal(seen, 'via-file-io', 'file I/O continuation sees context');
  });
});
describe('Snapshot', () => {
  it('Snapshot — runWithValue() re-enters captured frame', (t) => {
    const ctx = new Context('snap');
    let snap: Snapshot | undefined;
    ctx.runWithValue('captured', () => {
      snap = ctx.snapshot();
    });
    t.equal(ctx.get(), undefined, 'outside scope');
    snap!.runWithValue(() => {
      t.equal(ctx.get(), 'captured', 'snapshot restores value');
    });
    t.equal(ctx.get(), undefined, 'restored after snapshot');
  });
  it('Snapshot — can be re-entered multiple times', (t) => {
    const ctx = new Context('multi-snap');
    let snap: Snapshot | undefined;
    ctx.runWithValue('snap-val', () => {
      snap = ctx.snapshot();
    });
    for (let i = 0; i < 3; i++) {
      snap!.runWithValue(() => {
        t.equal(ctx.get(), 'snap-val', `re-entry ${i} correct`);
      });
    }
  });
  it('snapshotAll — captures all slots', (t) => {
    const a = new Context('snap-a');
    const b = new Context('snap-b');
    let snap: Snapshot | undefined;
    a.runWithValue('va', () => {
      b.runWithValue('vb', () => {
        snap = snapshotAll();
      });
    });
    snap!.runWithValue(() => {
      t.equal(a.get(), 'va', 'a restored');
      t.equal(b.get(), 'vb', 'b restored');
    });
    t.equal(a.get(), undefined, 'a cleared after snap');
    t.equal(b.get(), undefined, 'b cleared after snap');
  });
  it('Snapshot — async re-entry propagates through await', async (t) => {
    const ctx = new Context('snap-async');
    let snap: Snapshot | undefined;
    ctx.runWithValue('snap-value', () => {
      snap = ctx.snapshot();
    });
    await snap!.runWithValue(async () => {
      await Promise.resolve();
      t.equal(ctx.get(), 'snap-value', 'snapshot value survives await');
    });
  });
});
describe('Topic', () => {
  it('topic() factory returns same instance for same name', (t) => {
    const a = topic('same-name-test');
    const b = topic('same-name-test');
    t.ok(a === b, 'same instance');
  });
  it('Topic — subscribe and publish', (t) => {
    const t1 = topic('pub-sub-test');
    const received: string[] = [];
    const handle = t1.subscribe((msg) => received.push(String(msg)));
    t1.publish('hello');
    t1.publish('world');
    t.deepEqual(received, ['hello', 'world'], 'received in order');
    handle.dispose();
  });
  it('Topic — hasSubscribers', (t) => {
    const t1 = new Topic('has-sub-test');
    t.ok(!t1.hasSubscribers, 'false before subscribe');
    const h = t1.subscribe(() => {});
    t.ok(t1.hasSubscribers, 'true after subscribe');
    h.dispose();
    t.ok(!t1.hasSubscribers, 'false after dispose');
  });
  it('Topic — unsubscribe removes callback', (t) => {
    const t1 = new Topic('unsub-test');
    const calls: string[] = [];
    const handle = t1.subscribe((msg) => calls.push(String(msg)));
    t1.publish('before');
    t1.unsubscribe(handle);
    t1.publish('after');
    t.deepEqual(calls, ['before'], 'not called after unsubscribe');
  });
  it('Topic — same fn can subscribe multiple times independently', (t) => {
    const t1 = new Topic('multi-sub-test');
    let count = 0;
    const fn = () => count++;
    const h1 = t1.subscribe(fn);
    const h2 = t1.subscribe(fn);
    t1.publish(null);
    t.equal(count, 2, 'called twice');
    h1.dispose();
    t1.publish(null);
    t.equal(count, 3, 'called once after first unsubscribe');
    h2.dispose();
  });
  it('Topic — publish does not enter context scopes', (t) => {
    const ctx = new Context('pub-no-ctx');
    const t1 = new Topic('pub-no-ctx-topic');
    t1.bindContext(ctx, (msg) => msg);
    let seen;
    t1.subscribe(() => {
      seen = ctx.get();
    });
    t1.publish('should-not-set');
    t.equal(seen, undefined, 'publish() alone does not enter context scopes');
  });
  it('Topic — subscriber errors are isolated', (t) => {
    const t1 = new Topic('error-isolation-test');
    const calls: string[] = [];
    t1.subscribe(() => {
      throw new Error('first fails');
    });
    t1.subscribe((msg) => calls.push(String(msg)));
    t1.publish('msg');
    t.deepEqual(calls, ['msg'], 'second subscriber still called');
  });
  it('Topic.runWithValue — enters bound context scope', (t) => {
    const ctx = new Context('topic-ctx');
    const t1 = new Topic('binding-test');
    t1.bindContext(ctx, (msg: unknown) => (msg as {
      id: string;
    }).id);
    let seen;
    t1.subscribe(() => {
      seen = ctx.get();
    });
    t1.runWithValue({ id: 'abc' }, () => {});
    t.equal(seen, 'abc', 'context set during publish');
  });
  it('Topic.runWithValue — fn sees context value', (t) => {
    const ctx = new Context('fn-ctx');
    const t1 = new Topic('fn-binding-test');
    t1.bindContext(ctx, (msg) => msg);
    let seen;
    t1.runWithValue('val', () => {
      seen = ctx.get();
    });
    t.equal(seen, 'val', 'fn sees context value');
  });
  it('Topic.runWithValue — context restored after fn', (t) => {
    const ctx = new Context('restore-ctx');
    const t1 = new Topic('restore-test');
    t1.bindContext(ctx, (msg) => msg);
    t1.runWithValue('inner', () => {});
    t.equal(ctx.get(), undefined, 'context restored');
  });
  it('Topic.runWithValue — context restored after fn throw', (t) => {
    const ctx = new Context('restore-throw-ctx');
    const t1 = new Topic('restore-throw-test');
    t1.bindContext(ctx, (msg) => msg);
    try {
      t1.runWithValue('inner', () => {
        throw new Error();
      });
    } catch (_) {}
    t.equal(ctx.get(), undefined, 'context restored after throw');
  });
  it('Topic.runWithValue — multiple bindings all entered', (t) => {
    const ctxA = new Context('multi-bind-a');
    const ctxB = new Context('multi-bind-b');
    const t1 = new Topic('multi-bind-test');
    t1.bindContext(ctxA, (msg: unknown) => (msg as {
      a: number;
    }).a);
    t1.bindContext(ctxB, (msg: unknown) => (msg as {
      b: number;
    }).b);
    let seenA, seenB;
    t1.runWithValue({
      a: 1,
      b: 2
    }, () => {
      seenA = ctxA.get();
      seenB = ctxB.get();
    });
    t.equal(seenA, 1, 'ctxA set');
    t.equal(seenB, 2, 'ctxB set');
  });
  it('Topic.runWithValue — bindings entered in registration order', (t) => {
    const order: string[] = [];
    const ctxA = new Context('order-a');
    const ctxB = new Context('order-b');
    const t1 = new Topic('order-test');
    // Use transforms to record entry order
    t1.bindContext(ctxA, (msg) => {
      order.push('a');
      return msg;
    });
    t1.bindContext(ctxB, (msg) => {
      order.push('b');
      return msg;
    });
    t1.runWithValue('x', () => {});
    t.deepEqual(order, ['a', 'b'], 'entered in registration order');
  });
  it('Topic.runWithValue — context propagates through await', async (t) => {
    const ctx = new Context('async-topic-ctx');
    const t1 = new Topic('async-topic-test');
    t1.bindContext(ctx, (msg) => msg);
    await t1.runWithValue('async-val', async () => {
      await Promise.resolve();
      t.equal(ctx.get(), 'async-val', 'context survives await inside runWithValue');
    });
  });
  it('Topic — unbindContext removes binding', (t) => {
    const ctx = new Context('unbind-ctx');
    const t1 = new Topic('unbind-test');
    const handle = t1.bindContext(ctx, (msg) => msg);
    t1.runWithValue('before', () => {});
    t.equal(ctx.get(), undefined, 'context restored after first call');
    handle.dispose();
    let seen;
    t1.runWithValue('after', () => {
      seen = ctx.get();
    });
    t.equal(seen, undefined, 'context not set after unbind');
  });
});
