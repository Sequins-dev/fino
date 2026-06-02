# js/realm/pool

fino:realm/pool - RealmPool with load-based dispatch.

A pool of warm thread realms that accept multiple concurrent tasks.  Tasks
are routed to the worker with the lowest predicted completion time, computed
from exponential moving averages of submission rate, completion rate, and
per-task latency.

Correlation IDs are generated on the parent side and propagated via
fino:context so that all async operations inside a pool task inherit the
parent's trace context.

Wire protocol (cross-Isolate via ThreadPort / ValueSerializer):

  Parent -> Worker: { __pool_call: true, correlationId: number, args: unknown[] }
  Worker -> Parent: { __pool_result: true, correlationId: number, result: unknown }
                    { __pool_error: true, correlationId: number, message: string, stack?: string }

The worker entry module simply default-exports a function.  The pool's
child-side bootstrap (in internal/bootstrap.mts) wraps it with the correlation ID
handling automatically when `__pool_call` messages arrive.

```ts
import { RealmPool } from 'fino:realm/pool';

const pool = new RealmPool({ entry: './worker.mts', size: 4 });
const result = await pool.call({ id: 'task-1' });
await pool.close();
```

## correlationIdContext

```ts
const correlationIdContext
```

Carries the correlation ID for the current pool task.
All code within `pool.call()` - including async continuations - can read
this value via `correlationIdContext.get()`.

```ts
import { correlationIdContext } from 'fino:realm/pool';
const id = correlationIdContext.get(); // string | undefined
```

## RealmPool

```ts
class RealmPool<F extends RealmFn = RealmFn> {
```

Pool of warm thread realms with load-based task dispatch.

Calls are sent to the worker predicted to complete soonest. Worker crashes
reject pending calls for that slot and trigger respawn while the pool is
open. `close()` must be called to stop workers when the pool is no longer
needed.

```ts
import { RealmPool } from 'fino:realm/pool';

const pool = new RealmPool<(value: number) => number>({ entry: './square.mts' });
const result = await pool.call(9);
await pool.close();
```

### constructor

```ts
constructor(opts: PoolOptions)
```

Create a pool of `size` warm thread-realm workers.

Workers are spawned immediately in the constructor.  The pool is ready as
soon as `new RealmPool(...)` returns - no separate `await pool.ready()`
call is needed.

Construction may throw if worker realm creation fails. The default timeout
is 30 seconds per task and the default close timeout is 5 seconds.

```ts
import { RealmPool } from 'fino:realm/pool';

const pool = new RealmPool({ entry: './worker.mts', size: 2 });
console.log(pool.size);
```

### size

```ts
get size(): number
```

Number of workers in the pool.

This is the configured pool width and remains stable after construction.
It does not report temporary crash or respawn state.

```ts
import { RealmPool } from 'fino:realm/pool';

const pool = new RealmPool({ entry: './worker.mts', size: 2 });
console.log(pool.size);
```

### pending

```ts
get pending(): number
```

Total number of in-flight tasks across all workers.

The value is a synchronous snapshot and may change as workers complete
calls. Timed-out calls are removed from this count when their timeout fires.

```ts
import { RealmPool } from 'fino:realm/pool';

const pool = new RealmPool({ entry: './worker.mts' });
const pending = pool.pending;
```

### call

```ts
call(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>>
```

Dispatch `args` to the least-loaded worker and return the result.

The current `correlationIdContext` value is propagated as a new correlation
ID (derived from the parent's) so downstream operations can link traces.

The promise resolves with the worker function's returned value. It rejects
when the worker reports an error, the pool is closed, a worker crashes, or
the per-task timeout elapses.

```ts
import { RealmPool } from 'fino:realm/pool';

const pool = new RealmPool<(name: string) => string>({ entry: './hello.mts' });
const greeting = await pool.call('Ana');
```

### close

```ts
async close(): Promise<void>
```

Stop dispatching new tasks, wait for all in-flight tasks to settle, then
terminate all workers.

After `close()` starts, future `call()` attempts reject with
`RealmPool is closed`. If in-flight tasks do not settle before
`closeTimeout`, their promises are rejected and worker ports are closed.

```ts
import { RealmPool } from 'fino:realm/pool';

const pool = new RealmPool({ entry: './worker.mts' });
await pool.close();
```
