/**
 * internal:scheduler/readiness — TypeScript-owned reactor pool.
 *
 * TypeScript owns pool sizing and lifecycle and creates each reactor thread
 * separately, so the pool can grow or shrink without changing native policy. A
 * reactor thread claims runnable Realms in wake order. Repeated wakes coalesce
 * without moving a Realm ahead of older work. At cooperative boundaries it
 * yields when another Realm can use its worker.
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
  takeReactorEvents,
} from 'internal:scheduler-native';
import { currentProcessReadinessController } from './reactor.ts';

/**
 * Reactor thread count: one fewer than the online processor count, or
 * `FINO_REACTOR_THREADS`. The reserved processor leaves capacity for the main
 * thread that routes reactor events and performs process-level coordination.
 * Multi-processor hosts retain at least two reactors so a Realm awaiting a
 * nested Realm cannot occupy the pool's only worker.
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
 * Pin the variable to 1 to get single-threaded behaviour back when isolating a
 * scheduling problem.
 */
/** Select the reactor pool size from a processor count and optional override. @internal */
export function selectReactorThreadCount(
  onlineProcessorCount: number,
  configuredValue?: string,
): number {
  const configured = Number(configuredValue ?? '');
  if (Number.isFinite(configured) && configured >= 1) return Math.floor(configured);
  const processors =
    Number.isFinite(onlineProcessorCount) && onlineProcessorCount >= 1
      ? Math.floor(onlineProcessorCount)
      : 1;
  if (processors === 1) return 1;
  return Math.max(2, processors - 1);
}

/** Return the process reactor thread count selected from the environment and host. @internal */
export function configuredReactorThreadCount(): number {
  return selectReactorThreadCount(onlineProcessors(), env['FINO_REACTOR_THREADS']);
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
  const threadCount = Math.max(1, Math.floor(options.threads ?? configuredReactorThreadCount()));
  const threads: number[] = [];
  for (let index = 0; index < threadCount; index++) threads.push(createReactorThread());

  const entry = createWorkload(entryPath);
  // Realms register their own wake descriptor the same way, whether they are
  // created here or by another realm: the mailbox tells this realm to watch it
  // and re-signal the owner. Keeping one path means the reactor cannot be woken
  // by two mechanisms with different lifetimes.
  registerReactorWake(entry.owner, entry.wakeFd);
  // Owners tracked here are the entry realm plus every realm it spawns onto the
  // same pool; the run ends only once all of them have settled.
  const liveOwners = new Set([entry.owner]);

  try {
    while (liveOwners.size > 0) {
      await loop.readable(controlFd);
      for (const event of takeReactorEvents()) {
        if (event.kind === 'activated') {
          liveOwners.add(event.owner);
          continue;
        }
        liveOwners.delete(event.owner);
        if (event.owner === entry.owner && event.kind === 'error') {
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
