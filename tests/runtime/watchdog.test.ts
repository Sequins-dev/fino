/**
 * The greedy-workload watchdog.
 *
 * Priority in the claim model is claim-time ordering, not preemption: a
 * reactor running a workload that never yields never asks for work again, so
 * the highest-priority entry can wait forever. These tests wedge a
 * single-threaded queue and check that the watchdog — which runs on a thread
 * that never claims work — sees and reports the deadlock.
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
  it('reports a slice that starves queued system work', async (t) => {
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

      // The warning escalates to a sustained stall while the deadlock holds.
      // Enforcement is deliberately not wired up yet, so this is the terminal
      // signal a supervisor acts on rather than a termination.
      const stalled = await collectEvents(queue.handle, 'stalled', 6000);
      t.ok(
        stalled.some((event) => event.kind === 'stalled'),
        `an unyielding slice keeps reporting: ${JSON.stringify(stalled.map((e) => e.kind))}`,
      );
    } finally {
      // The wedged slice must run itself out before its reactor can be
      // joined; a thread inside a non-yielding loop cannot be closed, which
      // is the whole reason the watchdog observes from elsewhere.
      await new Promise((resolve) => setTimeout(resolve, 11_000));
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
        !events.some((event) => event.kind === 'overrun' || event.kind === 'stalled'),
        `no escalation against healthy workloads: ${JSON.stringify(events.map((e) => e.kind))}`,
      );
    } finally {
      closeReactorThread(thread.handle);
      closeReactorQueue(queue.handle);
    }
  });
});
