# js/realm/pool

fino:realm/pool — RealmPool with load-based dispatch.

A pool of warm thread realms that accept multiple concurrent tasks.  Tasks
are routed to the worker with the lowest predicted completion time, computed
from exponential moving averages of submission rate, completion rate, and
per-task latency.

Correlation IDs are generated on the parent side and propagated via
fino:context so that all async operations inside a pool task inherit the
parent's trace context.

Wire protocol (cross-Isolate via ThreadPort / ValueSerializer):

  Parent → Worker:  { __pool_call: true, correlationId: number, args: unknown[] }
  Worker → Parent:  { __pool_result: true, correlationId: number, result: unknown }
                    { __pool_error:  true, correlationId: number, message: string, stack?: string }

The worker entry module simply default-exports a function.  The pool's
child-side bootstrap (in internal/bootstrap.mts) wraps it with the correlation ID
handling automatically when `__pool_call` messages arrive.

## correlationIdContext

```ts
const correlationIdContext
```

Carries the correlation ID for the current pool task.
All code within `pool.call()` — including async continuations — can read
this value via `correlationIdContext.get()`.

```ts
import { correlationIdContext } from 'fino:realm/pool';
const id = correlationIdContext.get(); // string | undefined
```

## PoolOptions

```ts
interface PoolOptions {
```

### entry

```ts
entry: string
```

Path to the worker entry module. Must default-export a function.

### size

```ts
size?: number
```

Number of workers. Defaults to `navigator.hardwareConcurrency`.

### realm

```ts
realm?: Omit<RealmOptions, 'entry' | 'thread'>
```

Base options forwarded to each worker Realm.

### timeout

```ts
timeout?: number
```

Per-task timeout in ms. 0 = no timeout. Default: 30 000.

### closeTimeout

```ts
closeTimeout?: number
```

Maximum ms to wait for in-flight tasks to settle during `close()`.
If the drain does not complete within this window, all remaining workers
are force-terminated. Default: 5 000.

## RealmPool

```ts
class RealmPool<F extends RealmFn = RealmFn> {
```

### constructor

```ts
constructor(opts: PoolOptions)
```

Create a pool of `size` warm thread-realm workers.

Workers are spawned immediately in the constructor.  The pool is ready as
soon as `new RealmPool(...)` returns — no separate `await pool.ready()`
call is needed.

### size

```ts
get size(): number
```

Number of workers in the pool.

### pending

```ts
get pending(): number
```

Total number of in-flight tasks across all workers.

### call

```ts
call(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>>
```

Dispatch `args` to the least-loaded worker and return the result.

The current `correlationIdContext` value is propagated as a new correlation
ID (derived from the parent's) so downstream operations can link traces.

### close

```ts
async close(): Promise<void>
```

Stop dispatching new tasks, wait for all in-flight tasks to settle, then
terminate all workers.
