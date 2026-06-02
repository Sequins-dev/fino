# js/context

fino:context — Async context propagation.

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
  console.log(requestId.get()); // 'abc-123' — propagated through await
});
```

## Context

```ts
class Context<T = unknown> {
```

Async-local context slot whose value follows promise continuations.

### constructor

```ts
constructor(name: string)
```

### name

```ts
get name()
```

The context name (readonly).

### get

```ts
get(): T | undefined
```

Return the current value of this context slot, or `undefined` if no value
has been set (or if `runClear` is active) in the current async scope.

### runWithValue

```ts
runWithValue<R>(value: T, fn: () => R): R
```

Run `fn` with this context slot set to `value`. The previous value is
restored when `fn` returns or throws, preserving proper scope nesting.

Works for both sync and async functions. When `fn` is async, all
continuations within the returned promise will see `value`.

### runClear

```ts
runClear<R>(fn: () => R): R
```

Run `fn` with this context slot explicitly cleared, making `get()` return
`undefined` for the duration of `fn` even if an outer scope has a value.
The previous value is restored afterwards.

### enterWith

```ts
enterWith(value: T): void
```

Unconditionally set this slot to `value` in the current async execution
scope without scheduling a restore. All future microtasks enqueued from
this point — and their continuations — will inherit the value.

Use sparingly. Unlike `runWithValue`, there is no automatic cleanup:
the caller is responsible for calling `exit()` when appropriate.

Analogous to Node.js `AsyncLocalStorage.enterWith()`.

### exit

```ts
exit(): void
```

Clear this slot in the current async execution scope.
Code running synchronously after this call will see `undefined`.
Previously-enqueued microtasks keep their captured value unchanged.

### snapshot

```ts
snapshot()
```

Capture the current frame as a `Snapshot` that can be re-entered later —
useful when manually scheduling callbacks outside the normal async flow
(e.g. passing callbacks to third-party queues or custom event emitters).

## Snapshot

```ts
class Snapshot {
```

A frozen capture of the full context frame at a point in time, across all
`Context` instances. Can be re-entered later via `runWithValue()`.

Obtain via `context.snapshot()` or the module-level `snapshotAll()`.

### constructor

```ts
constructor(handle: unknown)
```

### runWithValue

```ts
runWithValue<R>(fn: () => R): R
```

Run `fn` inside the snapshotted frame. The previous frame is restored
afterwards regardless of whether `fn` throws.

## snapshotAll

```ts
function snapshotAll(): Snapshot
```

Capture all current context slot values as a `Snapshot`. Useful at the
point where a callback is registered, so it can be replayed with the full
context frame intact when the callback is invoked later.
