/**
 * The greedy-workload watchdog.
 *
 * Priority in the claim model is claim-time ordering, not preemption: a
 * reactor running a workload that never yields never asks for work again, so
 * the highest-priority entry can wait forever. These tests wedge a
 * single-threaded queue and check that the watchdog — which runs on a thread
 * that never claims work — breaks the deadlock.
 */
import { describe, it } from 'fino:test/test';
import {
  closeReactorQueue,
  closeReactorThread,
  createReactorQueue,
  createReactorThread,
  createWorkload,
  submitReactorWorkload,
  takeReactorEvents,
} from 'internal:scheduler-native';
import { cwd } from 'fino:process';

const busy = `${cwd()}/tests/runtime/fixtures/busy-spin.ts`;
const busyTopLevel = `${cwd()}/tests/runtime/fixtures/busy-top-level.ts`;
const idle = `${cwd()}/tests/realm/fixtures/hello.ts`;

async function collectEvents(
  queue: number,
  wanted: string,
  timeoutMs: number,
): Promise<{ kind: string; owner: number }[]> {
  const seen: { kind: string; owner: number }[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const event of takeReactorEvents(queue)) seen.push(event);
    if (seen.some((event) => event.kind === wanted)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return seen;
}

describe('greedy workload watchdog', () => {
  it('terminates a slice that starves queued system work, freeing its reactor', async (t) => {
    // One thread, so a single non-yielding workload wedges the whole queue.
    // Thresholds are per queue so the test does not depend on process-wide
    // environment, and stays well inside the fixture's ten-second lifetime.
    const queue = createReactorQueue(false, { intervalMs: 100, stallMs: 500, sustainedMs: 2500 });
    const thread = createReactorThread(queue.handle);
    try {
      submitReactorWorkload(queue.handle, createWorkload(busy));
      await new Promise((resolve) => setTimeout(resolve, 500));
      // System-class work now has nowhere to run: the only reactor is inside
      // a slice that will never return to claim it.
      submitReactorWorkload(queue.handle, createWorkload(idle, true));

      const events = await collectEvents(queue.handle, 'overrun', 6000);
      const overrun = events.find((event) => event.kind === 'overrun');
      t.ok(
        overrun !== undefined,
        `the watchdog reported the wedged slice: ${JSON.stringify(events.map((e) => e.kind))}`,
      );

      // The warning escalates to termination, which frees the reactor.
      const halted = await collectEvents(queue.handle, 'halted', 8000);
      t.ok(
        halted.some((event) => event.kind === 'halted'),
        `an unyielding slice is terminated: ${JSON.stringify(halted.map((e) => e.kind))}`,
      );

      // The point of it all: the freed reactor claims and runs the
      // system-class work that was starved behind the runaway loop.
      const freed = await collectEvents(queue.handle, 'settled', 10_000);
      t.ok(
        freed.some((event) => event.kind === 'settled'),
        `the starved system work ran to completion: ${JSON.stringify(freed.map((e) => e.kind))}`,
      );
    } finally {
      closeReactorThread(thread.handle);
      closeReactorQueue(queue.handle);
    }
  });

  it('stays advisory while a module evaluation is the thing wedged', async (t) => {
    // Module evaluation is the one window where termination cannot be made
    // safe: V8's async-module resume CHECK-fails on a terminating isolate.
    // A top-level runaway therefore keeps reporting instead of halting —
    // and the deploy readiness gate is the layer that catches those.
    const queue = createReactorQueue(false, { intervalMs: 100, stallMs: 500, sustainedMs: 1500 });
    const thread = createReactorThread(queue.handle);
    try {
      submitReactorWorkload(queue.handle, createWorkload(busyTopLevel));
      await new Promise((resolve) => setTimeout(resolve, 300));
      submitReactorWorkload(queue.handle, createWorkload(idle, true));
      const events = await collectEvents(queue.handle, 'halted', 4000);
      t.ok(
        events.some((event) => event.kind === 'overrun'),
        `the wedge is still reported: ${JSON.stringify(events.map((e) => e.kind))}`,
      );
      t.ok(
        !events.some((event) => event.kind === 'halted'),
        `no termination inside module evaluation: ${JSON.stringify(events.map((e) => e.kind))}`,
      );
      // The finite fixture releases the reactor; the process must survive
      // the whole episode, which is the regression this test pins.
      const after = await collectEvents(queue.handle, 'settled', 10_000);
      t.ok(
        after.some((event) => event.kind === 'settled'),
        `the queue recovers once the evaluation ends: ${JSON.stringify(after.map((e) => e.kind))}`,
      );
    } finally {
      closeReactorThread(thread.handle);
      closeReactorQueue(queue.handle);
    }
  });

  it('stays silent while reactors keep claiming', async (t) => {
    const queue = createReactorQueue(false, { intervalMs: 100, stallMs: 500, sustainedMs: 2500 });
    const thread = createReactorThread(queue.handle);
    try {
      // Well-behaved work: the reactor returns to claim, so queued system
      // work is served and the watchdog has nothing to break.
      for (let i = 0; i < 3; i++) submitReactorWorkload(queue.handle, createWorkload(idle));
      submitReactorWorkload(queue.handle, createWorkload(idle, true));
      const events = await collectEvents(queue.handle, '__never__', 5000);
      t.ok(
        !events.some((event) => event.kind === 'overrun' || event.kind === 'halted'),
        `no escalation against healthy workloads: ${JSON.stringify(events.map((e) => e.kind))}`,
      );
    } finally {
      closeReactorThread(thread.handle);
      closeReactorQueue(queue.handle);
    }
  });
});
