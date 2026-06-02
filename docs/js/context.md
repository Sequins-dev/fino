# js/context

fino:context - Async context propagation.

A `Context` is a named slot whose value follows the causal chain of async
execution through `await` and `.then()`. It works by hooking into V8's ContinuationPreservedEmbedderData (CPED):
when a promise continuation is enqueued, the current frame is captured;
when the continuation runs, the frame is restored.

API mirrors the execution-flow library (closure-based):

```ts
import { Context } from './context.mts';

const requestId = new Context('requestId');

await requestId.runWithValue('abc-123', async () => {
  await someAsyncOp();
  console.log(requestId.get()); // 'abc-123' - propagated through await
});
```

## Context

```ts
class Context<T = unknown> {
```

Async-local context slot whose value follows promise continuations.

Each `Context` instance owns one independent slot. Values are scoped to the
current async execution frame and are restored after `runWithValue()` or
`runClear()` completes, even when the callback throws. Values are not shared
across unrelated realms or processes.

```ts
import { Context } from 'fino:context';

const requestId = new Context<string>('requestId');
await requestId.runWithValue('req-1', async () => {
  await Promise.resolve();
  console.log(requestId.get());
});
```

### constructor

```ts
constructor(name: string)
```

Create a context slot with a stable debug name.

The name is informational and does not affect lookup identity. Two
contexts with the same name remain separate slots. The constructor does not
install a value; `get()` returns `undefined` until a scope is entered.

```ts
import { Context } from 'fino:context';

const tenant = new Context<string>('tenant');
console.log(tenant.name);
```

### name

```ts
get name()
```

Read the debug name supplied to the constructor.

The value is read-only and never falls back to a generated name. It is safe
to use in logs, but it is not a unique key because callers may create
multiple contexts with the same name.

```ts
import { Context } from 'fino:context';

const ctx = new Context('request');
console.log(ctx.name);
```

### get

```ts
get(): T | undefined
```

Return the current value of this context slot, or `undefined` if no value
has been set (or if `runClear` is active) in the current async scope.

The lookup is synchronous and allocation-free in the common case. A stored
value of `undefined` is indistinguishable from an unset slot, so use a
sentinel object if that distinction matters.

```ts
import { Context } from 'fino:context';

const locale = new Context<string>('locale');
console.log(locale.get());
locale.runWithValue('en-US', () => console.log(locale.get()));
```

### runWithValue

```ts
runWithValue<R>(value: T, fn: () => R): R
```

Run `fn` with this context slot set to `value`. The previous value is
restored when `fn` returns or throws, preserving proper scope nesting.

Works for both sync and async functions. When `fn` is async, all
continuations within the returned promise will see `value`.

If `fn` throws, the previous frame is restored before the error propagates.
The returned value has exactly the same shape as `fn`'s return value; async
callbacks therefore return their original `Promise`.

```ts
import { Context } from 'fino:context';

const trace = new Context<string>('trace');
const result = await trace.runWithValue('abc', async () => {
  await Promise.resolve();
  return trace.get();
});
```

### runClear

```ts
runClear<R>(fn: () => R): R
```

Run `fn` with this context slot explicitly cleared, making `get()` return
`undefined` for the duration of `fn` even if an outer scope has a value.
The previous value is restored afterwards.

Use this when calling code that must not inherit sensitive request state.
As with `runWithValue()`, thrown errors propagate after restoration and
async continuations created inside `fn` observe the cleared slot.

```ts
import { Context } from 'fino:context';

const auth = new Context<string>('auth');
auth.runWithValue('token', () => {
  auth.runClear(() => console.log(auth.get()));
});
```

### enterWith

```ts
enterWith(value: T): void
```

Unconditionally set this slot to `value` in the current async execution
scope without scheduling a restore. All future microtasks enqueued from
this point - and their continuations - will inherit the value.

Use sparingly. Unlike `runWithValue`, there is no automatic cleanup:
the caller is responsible for calling `exit()` when appropriate.

Analogous to Node.js `AsyncLocalStorage.enterWith()`.

Prefer `runWithValue()` for bounded scopes. `enterWith()` is useful for
event-loop integration points that need to set state before scheduling
callbacks and then clear it explicitly.

```ts
import { Context } from 'fino:context';

const request = new Context<string>('request');
request.enterWith('req-42');
queueMicrotask(() => console.log(request.get()));
request.exit();
```

### exit

```ts
exit(): void
```

Clear this slot in the current async execution scope.
Code running synchronously after this call will see `undefined`.
Previously-enqueued microtasks keep their captured value unchanged.

`exit()` only clears this context's slot, not other `Context` instances.
It does not throw when the slot is already empty.

```ts
import { Context } from 'fino:context';

const ctx = new Context('request');
ctx.enterWith('req-1');
ctx.exit();
console.log(ctx.get());
```

### snapshot

```ts
snapshot()
```

Capture the current frame as a `Snapshot` that can be re-entered later -
useful when manually scheduling callbacks outside the normal async flow
(e.g. passing callbacks to third-party queues or custom event emitters).

The snapshot captures all context slots, not just this instance. Re-enter
it with `Snapshot.runWithValue()` around callbacks whose scheduler does
not preserve promise continuation state.

```ts
import { Context } from 'fino:context';

const ctx = new Context<string>('request');
const saved = ctx.runWithValue('req-1', () => ctx.snapshot());
saved.runWithValue(() => console.log(ctx.get()));
```

## Snapshot

```ts
class Snapshot {
```

A frozen capture of the full context frame at a point in time, across all
`Context` instances. Can be re-entered later via `runWithValue()`.

Obtain via `context.snapshot()` or the module-level `snapshotAll()`.

```ts
import { Context, snapshotAll } from 'fino:context';

const ctx = new Context<string>('request');
const snap = ctx.runWithValue('req-1', () => snapshotAll());
snap.runWithValue(() => console.log(ctx.get()));
```

### constructor

```ts
constructor(handle: unknown)
```

Create a snapshot wrapper around an opaque runtime context frame.

Application code normally obtains snapshots through `Context.snapshot()`
or `snapshotAll()`. The handle is intentionally opaque; passing an invalid
value can restore an unusable frame.

```ts
import { snapshotAll } from 'fino:context';

const snap = snapshotAll();
snap.runWithValue(() => console.log('restored'));
```

### runWithValue

```ts
runWithValue<R>(fn: () => R): R
```

Run `fn` inside the snapshotted frame. The previous frame is restored
afterwards regardless of whether `fn` throws.

The return value is the exact return value from `fn`. If `fn` schedules
promise continuations, those continuations inherit the snapshotted frame.

```ts
import { Context, snapshotAll } from 'fino:context';

const ctx = new Context<string>('trace');
const snap = ctx.runWithValue('abc', () => snapshotAll());
await snap.runWithValue(async () => ctx.get());
```

## snapshotAll

```ts
function snapshotAll(): Snapshot
```

Capture all current context slot values as a `Snapshot`. Useful at the
point where a callback is registered, so it can be replayed with the full
context frame intact when the callback is invoked later.

The returned object is independent of later `enterWith()` or `exit()` calls.
It may be reused for multiple callbacks.

```ts
import { Context, snapshotAll } from 'fino:context';

const ctx = new Context<string>('tenant');
const snap = ctx.runWithValue('acme', () => snapshotAll());
setTimeout(() => snap.runWithValue(() => console.log(ctx.get())), 0);
```
