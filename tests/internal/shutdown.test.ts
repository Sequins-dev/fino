/**
* Tests for internal:shutdown — registerShutdownHook and runShutdownHooks.
*/
import { describe, it } from 'fino:test/test';
import { placeScheduledRealm } from 'internal:realm/allocate';
import { mergeChildRules } from 'internal:realm-native';
import { registerShutdownHook, runShutdownHooks } from 'internal:shutdown';
const longRunningRealm = new URL('../realm/fixtures/long-running.ts', import.meta.url).pathname;
const rulesJson = mergeChildRules('[]') as string;
describe('runShutdownHooks — no-op on empty', () => {
  it('does not throw when no hooks are registered', async (t) => {
    // Drain any hooks left by previous suites, then confirm a fresh run is clean.
    await runShutdownHooks();
    let threw = false;
    try {
      await runShutdownHooks();
    } catch (_) {
      threw = true;
    }
    t.ok(!threw, 'runShutdownHooks with no hooks does not throw');
  });
});
describe('runShutdownHooks — reverse order', () => {
  it('executes hooks in reverse registration order (B before A)', async (t) => {
    const order: string[] = [];
    registerShutdownHook(() => {
      order.push('A');
    });
    registerShutdownHook(() => {
      order.push('B');
    });
    await runShutdownHooks();
    t.deepEqual(order, ['B', 'A'], 'later-registered hook runs first');
  });
});
describe('runShutdownHooks — error isolation', () => {
  it('a throwing hook does not prevent subsequent hooks from running', async (t) => {
    const ran: string[] = [];
    registerShutdownHook(() => {
      ran.push('first');
    });
    registerShutdownHook(() => {
      throw new Error('hook failure');
    });
    registerShutdownHook(() => {
      ran.push('third');
    });
    // runShutdownHooks runs in reverse, so order is: third, throws, first.
    let caught: unknown;
    try {
      await runShutdownHooks();
    } catch (err) {
      caught = err;
    }
    t.ok(caught instanceof Error, 'error is propagated');
    t.deepEqual(ran, ['third', 'first'], 'non-throwing hooks still ran');
  });
  it('multiple throwing hooks are collected into an aggregate error', async (t) => {
    registerShutdownHook(() => {
      throw new Error('err-A');
    });
    registerShutdownHook(() => {
      throw new Error('err-B');
    });
    let caught: unknown;
    try {
      await runShutdownHooks();
    } catch (err) {
      caught = err;
    }
    t.ok(caught instanceof Error, 'aggregate error thrown');
    const agg = caught as Error & {
      errors?: unknown[];
    };
    t.ok(Array.isArray(agg.errors), 'aggregate.errors is an array');
    t.equal(agg.errors!.length, 2, 'both errors captured');
  });
});
describe('registerShutdownHook — dispose / deregistration', () => {
  it('dispose() prevents the hook from running', async (t) => {
    let called = false;
    const handle = registerShutdownHook(() => {
      called = true;
    });
    handle.dispose();
    await runShutdownHooks();
    t.ok(!called, 'disposed hook was not called');
  });
  it('dispose() is idempotent — calling it twice does not throw', (t) => {
    const handle = registerShutdownHook(() => {});
    handle.dispose();
    let threw = false;
    try {
      handle.dispose();
    } catch (_) {
      threw = true;
    }
    t.ok(!threw, 'second dispose() does not throw');
  });
  it('dispose() only removes the specific registration, not others', async (t) => {
    const ran: string[] = [];
    const handleA = registerShutdownHook(() => {
      ran.push('A');
    });
    registerShutdownHook(() => {
      ran.push('B');
    });
    handleA.dispose();
    await runShutdownHooks();
    t.deepEqual(ran, ['B'], 'only the non-disposed hook ran');
  });
});
describe('runShutdownHooks — async hooks', () => {
  it('awaits async hooks before continuing', async (t) => {
    let resolved = false;
    registerShutdownHook(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      resolved = true;
    });
    await runShutdownHooks();
    t.ok(resolved, 'async hook was awaited to completion');
  });
});
describe('B2 regression: hooks registered during shutdown are also executed', () => {
  it('a hook registered inside another hook still runs', async (t) => {
    const ran: string[] = [];
    registerShutdownHook(() => {
      ran.push('outer');
      // Register a new hook while shutdown is already in progress.
      registerShutdownHook(() => {
        ran.push('inner');
      });
    });
    await runShutdownHooks();
    t.ok(ran.includes('outer'), 'outer hook ran');
    t.ok(ran.includes('inner'), 'inner hook registered during shutdown also ran');
  });
  it('inner hooks run after the outer hook that registered them (LIFO within batch)', async (t) => {
    const order: string[] = [];
    registerShutdownHook(() => {
      order.push('A');
      registerShutdownHook(() => {
        order.push('C');
      });
      registerShutdownHook(() => {
        order.push('B');
      });
    });
    await runShutdownHooks();
    // A runs first (it was the only hook in the original batch).
    // B and C are registered during A's run and execute in reverse order in the next batch.
    t.equal(order[0], 'A', 'outer hook ran first');
    t.ok(order.includes('B') && order.includes('C'), 'both inner hooks ran');
    t.ok(order.indexOf('A') < order.indexOf('B'), 'A before B');
    t.ok(order.indexOf('A') < order.indexOf('C'), 'A before C');
  });
});
describe('realm allocator shutdown registration', () => {
  it('registers a fresh hook after an earlier shutdown cycle', async (t) => {
    const first = await placeScheduledRealm({ entry: longRunningRealm, rulesJson });
    t.ok(first !== null, 'the first realm was placed');
    await runShutdownHooks();
    await first?.released;

    const second = await placeScheduledRealm({ entry: longRunningRealm, rulesJson });
    t.ok(second !== null, 'the second realm was placed');
    await runShutdownHooks();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const released = await Promise.race([
      second?.released.then(() => true),
      new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), 250); })
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (!released) {
      second?.revoke('test-cleanup');
      await second?.released;
    }
    t.equal(released, true, 'the second shutdown cycle stopped the replacement scheduler');

    const survivor = await placeScheduledRealm({ entry: longRunningRealm, rulesJson });
    const completed = await placeScheduledRealm({ entry: longRunningRealm, rulesJson });
    t.ok(survivor !== null && completed !== null, 'replacement realms were placed');
    completed?.revoke('completed');
    await completed?.released;

    let survivorTimeout: ReturnType<typeof setTimeout> | undefined;
    const survivorReleased = await Promise.race([
      survivor?.released.then(() => true),
      new Promise<false>((resolve) => { survivorTimeout = setTimeout(() => resolve(false), 100); })
    ]);
    if (survivorTimeout !== undefined) clearTimeout(survivorTimeout);
    survivor?.revoke('test-cleanup');
    await survivor?.released;
    t.equal(survivorReleased, false, 'a completed peer does not stop the surviving realm');
  });
});
