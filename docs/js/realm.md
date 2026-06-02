# js/realm

fino:realm — Realm construction and management.

A Realm is an isolated V8 Context with its own global object, module graph,
microtask queue, and event loop. The parent's import rule list governs every
module resolution in the child; the child can layer overrides on top.

The import rule list uses last-match-wins semantics. Declare a wildcard
first as the baseline and more specific patterns afterwards as overrides.

## ImportDirectiveSer

```ts
type ImportDirectiveSer = | 'inherit' | 'block' | { type: 'inherit' } | { type: 'block' } | { type: 'remap'; target: string } | { type: 'source'; code: string; source_map: string } | { type: 'facade'; specifier: string; exports: string[]; streams?: string[]; sinks?: string[] }
```

Wire-format representation of an ImportDirective, matching Rust's serde layout.

## ImportRule

```ts
interface ImportRule {
```

Import rule applied to module resolution inside a child realm.

### from

```ts
from?: string
```

Pattern matching the importing module's specifier. Absent = all modules.

### pattern

```ts
pattern: string
```

Pattern matching the specifier being imported.

### directive

```ts
directive: ImportDirectiveSer
```

## ImportMap

```ts
class ImportMap {
```

An ordered list of import rules to apply to a child Realm.

Rules are last-match-wins. Use `ImportMap.deny([...overrides])` to start
with a block-all baseline and punch specific exceptions, or
`ImportMap.inherit([...overrides])` to inherit all and restrict specifics.

The rules in this object are the *child-specific* overrides that are appended
after the parent's rules. The parent's rules always form the baseline.

### constructor

```ts
constructor(rules: ImportRule[])
```

### deny

```ts
static deny(overrides: ImportRule[]): ImportMap
```

Deny everything by default; allow/remap/facade specific specifiers.

The wildcard `{ pattern: '*', directive: 'block' }` is prepended, then
the caller's overrides follow (each overrides the wildcard for its pattern).

### inherit

```ts
static inherit(overrides: ImportRule[]): ImportMap
```

Inherit everything from the parent by default; restrict specific specifiers.

The wildcard `{ pattern: '*', directive: 'inherit' }` is prepended; the
caller's overrides follow. Effectively a no-op wildcard (Inherit is
dropped on the Rust side), but makes the intent explicit in code.

## FacadeHandle

```ts
class FacadeHandle {
```

A stateful object handle returned from a Facade handler.

When a scalar handler returns a `FacadeHandle`, the parent registers its
methods under a unique ID and sends `{ __handle: id, streams?: [...] }` to
the child.  The child receives a Proxy that routes subsequent method calls
back through `internal:parent-rpc` using the handle ID as the specifier.

```ts
facade.handle('open', async (path) => {
  const fh = await realFs.open(path, 'r');
  return new FacadeHandle(
    { stat: () => fh.stat(), close: () => fh.close() },
    { read: (_size) => fh.reader() },   // streaming method
  );
});
```

### constructor

```ts
constructor( scalar: Record<string, (...args: unknown[]) => unknown> = {}, streams: Record<string, (...args: unknown[]) => AsyncIterable<unknown>> = {}, sinks: Record<string, (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>> = {}, )
```

## Facade

```ts
class Facade {
```

Public facade exposed to a child realm as a synthetic module.

### constructor

```ts
constructor(specifier: string, exports: string[])
```

### from

```ts
static from(obj: object, opts: { specifier: string }): Facade
```

### handle

```ts
handle(method: string, fn: (...args: unknown[]) => Promise<unknown>): this
```

Register a scalar handler — result is returned as a single `__rpc_res`.

### stream

```ts
stream(method: string, fn: (...args: unknown[]) => AsyncIterable<unknown>): this
```

Register a read-stream handler — the AsyncIterable it returns is pumped
as `__rpc_chunk` / `__rpc_end` / `__rpc_err` envelopes (parent→child).

### sendStream

```ts
sendStream(method: string, fn: (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>): this
```

Register a write-stream (sink) handler — the child sends chunks to the
parent via `__rpc_send_chunk` envelopes (child→parent, no per-chunk ack).

The handler receives `(args, source: AsyncIterable<unknown>)` and should
drain `source` to completion before returning the final result.

Maps directly onto a QUIC client-initiated unidirectional stream when the
cluster transport is later upgraded to QUIC.

```ts
facade.sendStream('write', async (_args, source) => {
  let total = 0;
  for await (const chunk of source) total += (chunk as Uint8Array).byteLength;
  return { bytesWritten: total };
});
```

## DiskFsOptions

```ts
interface DiskFsOptions {
```

### root

```ts
root?: string
```

## DiskFsConfig

```ts
class DiskFsConfig {
```

Use the real on-disk filesystem for this Realm (system default).

### type

```ts
readonly type
```

### options

```ts
readonly options: DiskFsOptions
```

### constructor

```ts
constructor(options: DiskFsOptions = {})
```

### toJSON

```ts
toJSON(): Record<string, unknown>
```

### fromJSON

```ts
static fromJSON(json: Record<string, unknown>): DiskFsConfig
```

## SystemNetConfig

```ts
class SystemNetConfig {
```

Use the system network stack for this Realm (system default).

### type

```ts
readonly type
```

### toJSON

```ts
toJSON(): Record<string, unknown>
```

### fromJSON

```ts
static fromJSON(_json: Record<string, unknown>): SystemNetConfig
```

## SystemDnsConfig

```ts
class SystemDnsConfig {
```

Use the system DNS resolver for this Realm (system default).

### type

```ts
readonly type
```

### toJSON

```ts
toJSON(): Record<string, unknown>
```

### fromJSON

```ts
static fromJSON(_json: Record<string, unknown>): SystemDnsConfig
```

## RealmProviders

```ts
interface RealmProviders {
```

Provider overrides installed in a child realm.

### fs

```ts
fs?: DiskFsConfig
```

### net

```ts
net?: SystemNetConfig
```

### dns

```ts
dns?: SystemDnsConfig
```

## RealmOptions

```ts
interface RealmOptions {
```

Options for constructing and running a child realm.

### entry

```ts
entry: string
```

Path to the entry module to evaluate in the child Realm.

### root

```ts
root?: string
```

Filesystem root for module resolution. Inherits from parent if omitted.

### overrides

```ts
overrides?: ImportMap | ImportRule[]
```

Import rules for this Realm. Appended after the parent's rules;
last-match-wins. Use `ImportMap.deny([...])` or `ImportMap.inherit([...])`.

### providers

```ts
providers?: RealmProviders
```

Override specific I/O providers. Unspecified providers are inherited.

### blocked

```ts
blocked?: string[]
```

Module specifiers that should throw on import in the child Realm.

### thread

```ts
thread?: boolean
```

If true, spawn the child Realm on a separate OS thread with its own
V8 Isolate. Messaging uses V8 ValueSerializer over Rust mpsc channels
instead of same-Isolate structured clone.

### process

```ts
process?: boolean
```

If true, spawn the child Realm as a separate OS process for hard crash
isolation. Messaging uses framed binary over a Unix socketpair.
Mutually exclusive with `thread`.

### remote

```ts
remote?: boolean
```

If true, spawn the child Realm on a remote cluster node. Requires a
prior call to `startCluster()` or `joinCluster()` from `fino:cluster`.
Messaging uses the cluster PORT_MSG protocol over WebSocket.
Mutually exclusive with `thread` and `process`.

### watch

```ts
watch?: boolean
```

If true, automatically restart the child Realm whenever any file it
imported changes on disk. The JS `Realm` instance is stable across
reloads; only the underlying V8 context / thread / process is replaced.
Not supported with `remote: true`.

### repl

```ts
repl?: boolean
```

If true, run this child Realm in REPL mode. The child listens for
`{ __eval, id, code }` messages on its port and responds with
`{ __eval_result }` or `{ __eval_error }`. Embedded-only — not
compatible with `thread`, `process`, `remote`, or `watch`.

### input

```ts
input?: MessagePort
```

Parent-side MessagePort for communication with the child.
Ignored when `thread: true` or `process: true`.

### output

```ts
output?: MessagePort
```

Child-side MessagePort passed into the child Realm.
Must be provided together with `input`.
Ignored when `thread: true` or `process: true`.

## RealmFn

```ts
type RealmFn = (...args: any[]) => any
```

## ProcessPort

```ts
class ProcessPort extends BaseTransportPort {
```

ProcessPort wraps the process realm native functions with the same event-loop
integration as ThreadPort: register the wake-fd with loop.readable(), drain
messages on each wake, dispatch as MessageEvents.

### constructor

```ts
constructor(wakeReadFd: number, handle: number)
```

### postMessage

```ts
postMessage(message: any, transferOrOpts?: Transferable[] | StructuredSerializeOptions): void
```

### _onStart

```ts
protected override _onStart(): void
```

### _onClose

```ts
protected override _onClose(): void
```

### _drain

```ts
_drain(): void
```

## _stepChildren

```ts
function _stepChildren(): void
```

Step all active child Realms by one iteration. @internal

## _childrenAlive

```ts
function _childrenAlive(): boolean
```

Returns true if any child Realms are still running. @internal

## Realm

```ts
class Realm<F extends RealmFn = RealmFn> {
```

### port

```ts
readonly port: MessagePort | ThreadPort | ProcessPort | ClusterPort
```

Parent-side port for general communication with the child Realm.

### constructor

```ts
constructor(opts: RealmOptions)
```

### run

```ts
run(): Promise<void>
```

Run the child Realm to completion.

### call

```ts
call(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>>
```

Call the child Realm's default-exported function with `args`.

### terminate

```ts
terminate(): void
```

Signal the child Realm to stop.
