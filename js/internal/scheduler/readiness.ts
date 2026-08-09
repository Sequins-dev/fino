/**
 * internal:scheduler/readiness — TypeScript-owned reactor pool.
 *
 * TypeScript owns pool sizing and lifecycle and creates each reactor thread
 * separately, so the pool can grow or shrink without changing native policy. A
 * reactor thread mechanically claims the highest-priority runnable realm. It
 * retains its current isolate on ties and exits it only when a strictly
 * higher-priority realm is available.
 *
 * @internal
 */
import * as loop from 'internal:runtime/loop';
import { env } from '../../process.ts';
import { onlineProcessors } from '../runtime/libc.ts';
import {
  createReactorThread,
  createWorkload,
  closeReactorThread,
  registerReactorWake,
  startReactorPool,
  stopReactorPool,
  submitReactorWorkload,
  takeReactorEvents,
  workloadOwner,
  workloadWakeFd,
} from 'internal:scheduler-native';
import { currentProcessReadinessController } from './reactor.ts';

/**
 * Reactor thread count: one per online processor bar one, or
 * `FINO_REACTOR_THREADS`.
 *
 * The pool sized itself from `navigator.hardwareConcurrency`, which fino does
 * not define, so it silently ran a single thread for the whole life of the
 * reactor and realms never executed in parallel. Scaling out only became worth
 * taking once wake-ups were targeted: a shared condvar plus `notify_all` meant
 * every readiness completion dragged every parked worker out of the kernel, and
 * all but one found nothing to do. Per-operation cost for I/O-bound realms grew
 * with the thread count under that scheme and is flat under this one, while
 * CPU-bound realms overlap almost perfectly.
 *
 * One fewer reactor than processors, so the main thread — which owns the host
 * loop, the cluster session, and heartbeats — always has a core of its own.
 * Saturating every processor with workloads starves it into missing heartbeats,
 * and the node is swept from cluster membership while the scheduler underneath
 * it is working perfectly.
 *
 * Pin the variable to 1 to get single-threaded behaviour back when isolating a
 * scheduling problem.
 */
function configuredThreadCount(): number {
  const configured = Number(env['FINO_REACTOR_THREADS'] ?? '');
  if (Number.isFinite(configured) && configured >= 1) return Math.floor(configured);
  return Math.max(1, onlineProcessors() - 1);
}

/**
 * Run one entry realm on the process reactor pool until it, and every realm it
 * spawns, has settled.
 *
 * @internal
 */
export async function runReactorPool(
  entryPath: string,
  options: {
    threads?: number;
  } = {},
): Promise<void> {
  const readiness = currentProcessReadinessController();
  if (readiness === undefined) {
    throw new Error('the process scheduler must run in the main TypeScript realm');
  }

  const controlFd = startReactorPool();
  const threadCount = Math.max(1, Math.floor(options.threads ?? configuredThreadCount()));
  const threads: number[] = [];
  for (let index = 0; index < threadCount; index++) threads.push(createReactorThread().handle);

  // Creating a workload and queueing it are separate steps: until it is
  // submitted, no reactor can claim it, which is what makes it safe to read its
  // owner and arm its wake descriptor first. Doing that after submission would
  // race a reactor that has already started the realm.
  const workload = createWorkload(entryPath);
  const owner = workloadOwner(workload);
  // Realms register their own wake descriptor the same way, whether they are
  // created here or by another realm: the mailbox tells this realm to watch it
  // and re-signal the owner. Keeping one path means the reactor cannot be woken
  // by two mechanisms with different lifetimes.
  registerReactorWake(owner, workloadWakeFd(workload));
  submitReactorWorkload(null, workload);
  // Owners tracked here are the entry realm plus every realm it spawns onto the
  // same pool; the run ends only once all of them have settled.
  const liveOwners = new Set([owner]);

  try {
    while (liveOwners.size > 0) {
      await loop.readable(controlFd);
      for (const event of takeReactorEvents()) {
        // `settled`, `error` and `shed` retire an owner; `submitted` and
        // `activated` announce one. `overrun` and `halted` are watchdog
        // escalations against a slice, and the workload they interrupt still
        // reports its own terminal event afterwards — treating them as
        // terminal would end the run while realms were still going.
        switch (event.kind) {
          case 'submitted':
          case 'activated':
            liveOwners.add(event.owner);
            continue;
          case 'overrun':
          case 'halted':
            continue;
          default:
            break;
        }
        liveOwners.delete(event.owner);
        if (event.owner === owner && event.kind === 'error') {
          throw event.error ?? `scheduled realm ${event.owner} failed`;
        }
      }
    }
  } finally {
    loop.removeRead(controlFd);
    for (const thread of threads) closeReactorThread(thread);
    stopReactorPool();
  }
}
