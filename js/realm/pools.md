---
weight: 16
---
# Realm Pools

A `RealmPool` maintains a set of warm thread realms and dispatches tasks across them using load-based routing. Pools are the right choice when you have many repeated, independent tasks that should run in parallel without the overhead of spawning a new realm for each one.

## Creating a pool

```ts
import { RealmPool } from 'fino:realm/pool';

const pool = new RealmPool({
  entry: './worker.mts',
  size: 4,
});
```

Workers are spawned immediately in the constructor — there is no separate startup promise. The pool is ready to accept calls as soon as `new RealmPool(...)` returns.

`size` defaults to `navigator.hardwareConcurrency` if available, or `4` otherwise. Pass additional realm options via `realm` to apply import rules or other settings to every worker:

```ts
import { ImportMap } from 'fino:realm';
import { RealmPool } from 'fino:realm/pool';

const pool = new RealmPool({
  entry: './worker.mts',
  size: 2,
  realm: {
    overrides: ImportMap.inherit([
      { pattern: 'fino:process', directive: 'block' },
    ]),
  },
});
```

## Dispatching calls

The worker's entry module must default-export a function. `pool.call()` sends arguments to the worker with the lowest predicted completion time and resolves with the function's return value:

```ts
// worker.mts
export default (n: number): number => n * n;

// parent
const result = await pool.call(9);  // 81
```

Type the pool with the worker function signature for end-to-end type safety:

```ts
const pool = new RealmPool<(n: number) => number>({ entry: './square.mts' });
const result = await pool.call(9);  // result is typed as number
```

Concurrent calls are spread across workers automatically. Each worker can handle multiple calls in flight at the same time. The pool routes new calls to whichever worker is predicted to finish soonest based on exponential moving averages of each worker's latency and throughput.

## Timeouts and errors

The default per-task timeout is 30 seconds. Tasks that do not respond in time reject with a timeout error. Pass `timeout: 0` to disable timeouts. Pass `timeout` in milliseconds to set a custom limit:

```ts
const pool = new RealmPool({
  entry: './worker.mts',
  timeout: 10_000,  // 10 seconds
});
```

Worker errors propagate normally: if the child function throws, `pool.call()` rejects with the same error message. If a worker crashes entirely, its pending calls are rejected and the pool respawns a replacement worker for that slot. Other workers continue serving calls without interruption.

## Inspecting the pool

`pool.size` is the number of workers configured at construction and stays constant. `pool.pending` is a live snapshot of in-flight tasks across all workers:

```ts
console.log(`${pool.pending} tasks across ${pool.size} workers`);
```

The pool does not buffer or reject incoming calls based on load — tasks accumulate on workers. If you need external backpressure, read `pool.pending` before dispatching.

## Closing the pool

`pool.close()` stops accepting new calls, waits for in-flight tasks to settle, then terminates all workers:

```ts
await pool.close();
```

Future `call()` attempts after `close()` starts reject immediately. If in-flight tasks do not settle within `closeTimeout` (default 5 seconds), their promises are force-rejected and workers are terminated. Configure `closeTimeout` when you need a shorter or longer drain window:

```ts
const pool = new RealmPool({
  entry: './worker.mts',
  closeTimeout: 1_000,  // force-terminate after 1 second if still draining
});
await pool.close();
```

The pool also implements `Symbol.asyncDispose`:

```ts
await using pool = new RealmPool({ entry: './worker.mts' });
// pool.close() is called automatically when the block exits
```

## Correlation IDs

`correlationIdContext` from `fino:realm/pool` is a context slot that carries a correlation ID through each call. Code running inside a pool task — including async continuations — can read it via `.get()`. This is useful for linking pool tasks to traces or log streams:

```ts
// worker.mts (child)
import { correlationIdContext } from 'fino:realm/pool';

export default async function processJob(jobId: string) {
  const correlationId = correlationIdContext.get();
  logger.info({ correlationId, jobId }, 'processing');
  // ...
}
```

The pool generates a correlation ID for each `call()` and propagates it automatically. You do not need to pass it as an argument.

## When to use a pool

Pools work well for repeated, independent, CPU-bound tasks: image processing, parsing, compression, model inference, document rendering. Keep workers warm rather than spawning a new realm per task whenever the work pattern is predictable and the per-task result is self-contained.

Pools are intentionally local — they create thread realms in the current process only. For distributing work across a cluster, use `Realm({ remote: true })` from `fino:realm` directly. Remote realms run the same entry module and expose the same `call()` interface, but execution happens on a cluster worker node.
