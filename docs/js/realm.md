# js/realm

fino:realm - Realm construction and management.

A Realm is an isolated V8 Context with its own global object, module graph,
microtask queue, and event loop. The parent's import rule list governs every
module resolution in the child; the child can layer overrides on top.

The import rule list uses last-match-wins semantics. Declare a wildcard
first as the baseline and more specific patterns afterwards as overrides.

```ts
import { Realm, ImportMap } from 'fino:realm';

const realm = new Realm({
  entry: './worker.mts',
  thread: true,
  overrides: ImportMap.inherit([
    { pattern: 'fino:process', directive: 'block' },
  ]),
});
const result = await realm.call('job-1');
await realm.terminate();
```

## ImportDirectiveSer

```ts
type ImportDirectiveSer = 'inherit' | 'block' | {
  type: 'inherit';
} | {
  type: 'block';
} | {
  type: 'remap';
  target: string;
} | {
  type: 'source';
  code: string;
  source_map: string;
} | {
  type: 'facade';
  specifier: string;
  exports: string[];
  streams?: string[];
  sinks?: string[];
}
```

Wire-format representation of an import directive.

Directives control how a child realm resolves an import that matches an
`ImportRule`. String forms are accepted for convenience and normalized to
the Rust serde layout before crossing the native bridge. `source` injects an
in-memory module, `remap` redirects to another specifier, and `facade`
exposes parent-side RPC handlers.

```ts
import type { ImportDirectiveSer } from 'fino:realm';

const directive: ImportDirectiveSer = {
  type: 'remap',
  target: './sandboxed-logger.mts',
};
```

## ImportRule

```ts
interface ImportRule {
```

Import rule applied to module resolution inside a child realm.

Rules are evaluated with last-match-wins semantics after the parent realm's
inherited rules. A matching rule may inherit, block, remap, inject source,
or expose a facade. Invalid patterns are rejected by the native loader when
the child realm is created.

```ts
import type { ImportRule } from 'fino:realm';

const rule: ImportRule = {
  pattern: 'fino:process',
  directive: 'block',
};
```

### from

```ts
from?: string
```

Optional pattern matching the importing module's specifier.

When omitted, the rule can apply regardless of which module performs the
import. Use this for broad allow/deny lists, and provide `from` when only a
specific importer should receive an override.

```ts
import type { ImportRule } from 'fino:realm';

const rule: ImportRule = {
  from: './plugin-host.mts',
  pattern: './plugin-api.mts',
  directive: 'inherit',
};
```

### pattern

```ts
pattern: string
```

Pattern matching the specifier being imported.

This field is required. `*` is commonly used as a baseline rule, with more
specific patterns appended later as overrides.

```ts
import type { ImportRule } from 'fino:realm';

const blockAll: ImportRule = { pattern: '*', directive: 'block' };
```

### directive

```ts
directive: ImportDirectiveSer
```

Resolution action to apply when the rule matches.

`inherit` falls back to the parent rule set, `block` rejects resolution,
and object forms can remap, inject source, or expose a facade. Facade
instances are accepted and normalized during realm construction.

```ts
import type { ImportRule } from 'fino:realm';

const rule: ImportRule = {
  pattern: 'virtual:config',
  directive: { type: 'source', code: 'export const port = 8080;', source_map: '' },
};
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

```ts
const documentedClass = 'ImportMap';
console.log(documentedClass);
```

### constructor

```ts
constructor(rules: ImportRule[])
```

Create an ordered import map from explicit rules.

The rules are stored as child-specific overrides and later appended after
parent rules. The constructor does not add a wildcard baseline; use
`ImportMap.deny()` or `ImportMap.inherit()` when you want that default.

```ts
import { ImportMap } from 'fino:realm';

const map = new ImportMap([{ pattern: 'fino:process', directive: 'block' }]);
```

### deny

```ts
static deny(overrides: ImportRule[]): ImportMap
```

Deny everything by default; allow/remap/facade specific specifiers.

The wildcard `{ pattern: '*', directive: 'block' }` is prepended, then
the caller's overrides follow (each overrides the wildcard for its pattern).

```ts
import { ImportMap, Realm } from 'fino:realm';

const overrides = ImportMap.deny([
  { pattern: './worker-api.mts', directive: 'inherit' },
]);
new Realm({ entry: './worker.mts', overrides });
```

### inherit

```ts
static inherit(overrides: ImportRule[]): ImportMap
```

Inherit everything from the parent by default; restrict specific specifiers.

The wildcard `{ pattern: '*', directive: 'inherit' }` is prepended; the
caller's overrides follow. Effectively a no-op wildcard (Inherit is
dropped on the Rust side), but makes the intent explicit in code.

```ts
import { ImportMap, Realm } from 'fino:realm';

const overrides = ImportMap.inherit([
  { pattern: 'fino:process', directive: 'block' },
]);
new Realm({ entry: './worker.mts', overrides });
```

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
constructor(
  scalar: Record<string, (
    ...args: unknown[]
  ) => unknown> = {
  },
  streams: Record<string, (
    ...args: unknown[]
  ) => AsyncIterable<unknown>> = {
  },
  sinks: Record<string, (
    args: unknown[], source: AsyncIterable<unknown>
  ) => Promise<unknown>> = {
  }
)
```

Create a stateful handle with scalar, read-stream, and write-stream methods.

Scalar methods return one response, stream methods return an
`AsyncIterable`, and sink methods receive chunks from the child as an
`AsyncIterable`. Empty maps are allowed.

```ts
import { FacadeHandle } from 'fino:realm';

const handle = new FacadeHandle(
  { stat: () => ({ size: 10 }) },
  { read: async function* () { yield new Uint8Array([1, 2, 3]); } },
);
```

## Facade

```ts
class Facade {
```

Public facade exposed to a child realm as a synthetic module.

A facade declares the names available to child imports and binds parent-side
handlers for those names. Calls cross the realm boundary through RPC, so
arguments and results must be serializable by the active realm transport
unless they are represented as streams or `FacadeHandle` proxies.

```ts
import { Facade, ImportMap, Realm } from 'fino:realm';

const api = new Facade('app:api', ['version'])
  .handle('version', async () => '1.0.0');

new Realm({
  entry: './worker.mts',
  overrides: ImportMap.inherit([{ pattern: 'app:api', directive: api }]),
});
```

### constructor

```ts
constructor(specifier: string, exports: string[])
```

Create a facade for a synthetic module specifier.

`exports` declares the scalar method names visible in the child module.
Register matching handlers with `handle()`. Stream and sink names are
declared by `stream()` and `sendStream()`.

```ts
import { Facade } from 'fino:realm';

const facade = new Facade('app:math', ['double'])
  .handle('double', async (value) => Number(value) * 2);
```

### from

```ts
static from(obj: object, opts: {
  specifier: string;
}): Facade
```

Create a facade from callable properties on an object or class instance.

Own functions and prototype methods are exported. Non-function properties
are ignored. Each generated handler calls the original method with the
original object as the receiver expression.

```ts
import { Facade } from 'fino:realm';

const service = { ping: async () => 'pong' };
const facade = Facade.from(service, { specifier: 'app:service' });
```

### handle

```ts
handle(method: string, fn: (...args: unknown[]) => Promise<unknown>): this
```

Register a scalar handler.

The handler receives the child call arguments and returns one result. A
thrown error or rejected promise is sent back as an RPC error. Returning a
`FacadeHandle` creates a stateful child-side proxy.

```ts
import { Facade } from 'fino:realm';

const facade = new Facade('app:math', ['add']);
facade.handle('add', async (a, b) => Number(a) + Number(b));
```

### stream

```ts
stream(method: string, fn: (...args: unknown[]) => AsyncIterable<unknown>): this
```

Register a read-stream handler - the AsyncIterable it returns is pumped
as `__rpc_chunk` / `__rpc_end` / `__rpc_err` envelopes (parent->child).

The method name is added to the facade's stream export list if it is not
already present. Errors thrown while creating or consuming the iterable are
delivered to the child as stream errors.

```ts
import { Facade } from 'fino:realm';

const facade = new Facade('app:logs', []);
facade.stream('tail', async function* () {
  yield 'line one';
});
```

### sendStream

```ts
sendStream(
  method: string,
  fn: (
    args: unknown[],
    source: AsyncIterable<unknown>
  ) => Promise<unknown>
): this
```

Register a write-stream (sink) handler - the child sends chunks to the
parent via `__rpc_send_chunk` envelopes (child->parent, no per-chunk ack).

The handler receives `(args, source: AsyncIterable<unknown>)` and should
drain `source` to completion before returning the final result.

Maps directly onto a QUIC client-initiated unidirectional stream when the
cluster transport is later upgraded to QUIC.

```ts
import { Facade } from 'fino:realm';

const facade = new Facade('app:upload', []);
facade.sendStream('write', async (_args, source) => {
  let total = 0;
  for await (const chunk of source) total += (chunk as Uint8Array).byteLength;
  return { bytesWritten: total };
});
```

## DiskFsConfig

```ts
class DiskFsConfig {
```

Use the real on-disk filesystem for this realm.

This legacy provider config is kept for backwards compatibility. New code
should prefer explicit import rules where possible.

```ts
import { DiskFsConfig, Realm } from 'fino:realm';

new Realm({
  entry: './worker.mts',
  providers: { fs: new DiskFsConfig({ root: '/srv/app' }) },
});
```

### type

```ts
readonly type
```

Provider discriminator serialized by `toJSON()`.

```ts
import { DiskFsConfig } from 'fino:realm';

console.log(new DiskFsConfig().type);
```

### options

```ts
readonly options: DiskFsOptions
```

Options supplied to the disk filesystem provider.

The object is stored as provided by the constructor. Omitted options are
represented by an empty object.

```ts
import { DiskFsConfig } from 'fino:realm';

const config = new DiskFsConfig({ root: '/tmp/app' });
console.log(config.options.root);
```

### constructor

```ts
constructor(options: DiskFsOptions = {})
```

Create a disk filesystem provider config.

The default options object is empty. Construction does not verify that the
root exists; provider setup handles filesystem failures later.

```ts
import { DiskFsConfig } from 'fino:realm';

const config = new DiskFsConfig({ root: '/srv/app' });
```

### toJSON

```ts
toJSON(): Record<string, unknown>
```

Serialize this provider config.

The result includes the provider type and any configured options. It is
suitable for legacy config persistence, not for direct import-rule use.

```ts
import { DiskFsConfig } from 'fino:realm';

const json = new DiskFsConfig({ root: '/srv/app' }).toJSON();
```

### fromJSON

```ts
static fromJSON(json: Record<string, unknown>): DiskFsConfig
```

Recreate a disk provider config from serialized data.

Unknown keys are ignored. Missing `root` produces a config with default
options.

```ts
import { DiskFsConfig } from 'fino:realm';

const config = DiskFsConfig.fromJSON({ type: 'disk', root: '/srv/app' });
```

## SystemNetConfig

```ts
class SystemNetConfig {
```

Use the system network stack for this realm.

This legacy provider config maps the network provider import back to the
inherited system provider.

```ts
import { Realm, SystemNetConfig } from 'fino:realm';

new Realm({ entry: './worker.mts', providers: { net: new SystemNetConfig() } });
```

### type

```ts
readonly type
```

Provider discriminator serialized by `toJSON()`.

```ts
import { SystemNetConfig } from 'fino:realm';

console.log(new SystemNetConfig().type);
```

### toJSON

```ts
toJSON(): Record<string, unknown>
```

Serialize this provider config.

The result has no options because the system network provider has no
JS-visible configuration in this compatibility layer.

```ts
import { SystemNetConfig } from 'fino:realm';

const json = new SystemNetConfig().toJSON();
```

### fromJSON

```ts
static fromJSON(_json: Record<string, unknown>): SystemNetConfig
```

Recreate a system network provider config from serialized data.

The input is accepted for compatibility and otherwise ignored.

```ts
import { SystemNetConfig } from 'fino:realm';

const config = SystemNetConfig.fromJSON({ type: 'system-net' });
```

## SystemDnsConfig

```ts
class SystemDnsConfig {
```

Use the system DNS resolver for this realm.

This legacy provider config maps DNS provider imports back to the inherited
system resolver.

```ts
import { Realm, SystemDnsConfig } from 'fino:realm';

new Realm({ entry: './worker.mts', providers: { dns: new SystemDnsConfig() } });
```

### type

```ts
readonly type
```

Provider discriminator serialized by `toJSON()`.

```ts
import { SystemDnsConfig } from 'fino:realm';

console.log(new SystemDnsConfig().type);
```

### toJSON

```ts
toJSON(): Record<string, unknown>
```

Serialize this provider config.

The result has no options because the system DNS provider has no
JS-visible configuration in this compatibility layer.

```ts
import { SystemDnsConfig } from 'fino:realm';

const json = new SystemDnsConfig().toJSON();
```

### fromJSON

```ts
static fromJSON(_json: Record<string, unknown>): SystemDnsConfig
```

Recreate a system DNS provider config from serialized data.

The input is accepted for compatibility and otherwise ignored.

```ts
import { SystemDnsConfig } from 'fino:realm';

const config = SystemDnsConfig.fromJSON({ type: 'system-dns' });
```

## RealmProviders

```ts
interface RealmProviders {
```

Legacy provider overrides installed in a child realm.

Prefer `RealmOptions.overrides` with explicit import rules for new code.
Unspecified providers are inherited from the parent realm.

```ts
import { DiskFsConfig, type RealmProviders } from 'fino:realm';

const providers: RealmProviders = {
  fs: new DiskFsConfig({ root: '/srv/app' }),
};
```

### fs

```ts
fs?: DiskFsConfig
```

Filesystem provider override.

When omitted, filesystem bindings are inherited. This compatibility field
currently supports the disk filesystem provider config.

```ts
import { DiskFsConfig, type RealmProviders } from 'fino:realm';

const providers: RealmProviders = { fs: new DiskFsConfig() };
```

### net

```ts
net?: SystemNetConfig
```

Network provider override.

When omitted, network provider bindings are inherited.

```ts
import { SystemNetConfig, type RealmProviders } from 'fino:realm';

const providers: RealmProviders = { net: new SystemNetConfig() };
```

### dns

```ts
dns?: SystemDnsConfig
```

DNS provider override.

When omitted, DNS provider bindings are inherited.

```ts
import { SystemDnsConfig, type RealmProviders } from 'fino:realm';

const providers: RealmProviders = { dns: new SystemDnsConfig() };
```

## RealmOptions

```ts
interface RealmOptions {
```

Options for constructing and running a child realm.

Exactly one of `thread`, `process`, or `remote` may be used for isolated
execution modes. Without those flags, the realm is embedded in the current
isolate with its own context and module graph.

```ts
import { Realm, type RealmOptions } from 'fino:realm';

const options: RealmOptions = { entry: './worker.mts', thread: true };
const realm = new Realm(options);
```

### entry

```ts
entry: string
```

Path to the entry module to evaluate in the child realm.

The path is resolved by the runtime loader using the realm root and import
rules. The module may default-export a function for `Realm.call()`.

```ts
import type { RealmOptions } from 'fino:realm';

const options: RealmOptions = { entry: './worker.mts' };
```

### root

```ts
root?: string
```

Filesystem root for module resolution.

When omitted, the child inherits the parent's root. The root affects module
lookup and any providers that consult realm root state.

```ts
import type { RealmOptions } from 'fino:realm';

const options: RealmOptions = { entry: './worker.mts', root: '/srv/app' };
```

### overrides

```ts
overrides?: ImportMap | ImportRule[]
```

Import rules for this Realm. Appended after the parent's rules;
last-match-wins. Use `ImportMap.deny([...])` or `ImportMap.inherit([...])`.

```ts
import { ImportMap, type RealmOptions } from 'fino:realm';

const options: RealmOptions = {
  entry: './worker.mts',
  overrides: ImportMap.deny([{ pattern: './api.mts', directive: 'inherit' }]),
};
```

### providers

```ts
providers?: RealmProviders
```

Override specific I/O providers. Unspecified providers are inherited.

```ts
import { DiskFsConfig, type RealmOptions } from 'fino:realm';

const options: RealmOptions = {
  entry: './worker.mts',
  providers: { fs: new DiskFsConfig() },
};
```

### blocked

```ts
blocked?: string[]
```

Module specifiers that should throw on import in the child Realm.

```ts
import type { RealmOptions } from 'fino:realm';

const options: RealmOptions = {
  entry: './worker.mts',
  blocked: ['fino:process'],
};
```

### thread

```ts
thread?: boolean
```

If true, spawn the child Realm on a separate OS thread with its own
V8 Isolate. Messaging uses V8 ValueSerializer over Rust mpsc channels
instead of same-Isolate structured clone.

```ts
import type { RealmOptions } from 'fino:realm';

const options: RealmOptions = { entry: './worker.mts', thread: true };
```

### process

```ts
process?: boolean
```

If true, spawn the child Realm as a separate OS process for hard crash
isolation. Messaging uses framed binary over a Unix socketpair.
Mutually exclusive with `thread`.

```ts
import type { RealmOptions } from 'fino:realm';

const options: RealmOptions = { entry: './worker.mts', process: true };
```

### remote

```ts
remote?: boolean
```

If true, spawn the child Realm on a remote cluster node. Requires a
prior call to `startCluster()` or `joinCluster()` from `fino:cluster`.
Messaging uses the cluster PORT_MSG protocol over WebSocket.
Mutually exclusive with `thread` and `process`.

```ts
import type { RealmOptions } from 'fino:realm';

const options: RealmOptions = { entry: './worker.mts', remote: true };
```

### watch

```ts
watch?: boolean
```

If true, automatically restart the child Realm whenever any file it
imported changes on disk. The JS `Realm` instance is stable across
reloads; only the underlying V8 context / thread / process is replaced.
Not supported with `remote: true`.

```ts
import type { RealmOptions } from 'fino:realm';

const options: RealmOptions = { entry: './worker.mts', watch: true };
```

### repl

```ts
repl?: boolean
```

If true, run this child Realm in REPL mode. The child listens for
`{ __eval, id, code }` messages on its port and responds with
`{ __eval_result }` or `{ __eval_error }`. Embedded-only - not
compatible with `thread`, `process`, `remote`, or `watch`.

```ts
import type { RealmOptions } from 'fino:realm';

const options: RealmOptions = { entry: './repl-host.mts', repl: true };
```

### input

```ts
input?: MessagePort
```

Parent-side MessagePort for communication with the child.
Ignored when `thread: true` or `process: true`.

Must be paired with `output`. If omitted, the realm constructor creates a
fresh `MessageChannel` and exposes the parent side as `realm.port`.

```ts
import { MessageChannel } from 'fino:realm/messaging';
import type { RealmOptions } from 'fino:realm';

const { port1, port2 } = new MessageChannel();
const options: RealmOptions = { entry: './worker.mts', input: port1, output: port2 };
```

### output

```ts
output?: MessagePort
```

Child-side MessagePort passed into the child Realm.
Must be provided together with `input`.
Ignored when `thread: true` or `process: true`.

The child can import `fino:realm/self` to access this port. Passing only
`output` without `input` is ignored by the embedded constructor path.

```ts
import { MessageChannel } from 'fino:realm/messaging';
import type { RealmOptions } from 'fino:realm';

const { port1, port2 } = new MessageChannel();
const options: RealmOptions = { entry: './worker.mts', input: port1, output: port2 };
```

## RealmSourceOptions

```ts
interface RealmSourceOptions extends Omit<RealmOptions, 'entry' | 'watch'> {
```

Options for creating a Realm from in-memory entrypoint source.

Source realms run the provided text as a normal ESM entry module, so static
imports, type imports, and top-level await behave the same as file-backed
entries. `watch` is intentionally unavailable because there is no entry file
to monitor; use a file-backed `Realm` when entrypoint reloads are required.

```ts
import { Realm } from 'fino:realm';

const realm = Realm.fromSource(`
  import { basename } from 'fino:file/path';

  if (basename('/tmp/example.mts') !== 'example.mts') {
    throw new Error('unexpected basename');
  }
`);
await realm.run();
```

### specifier

```ts
specifier?: string
```

Module specifier assigned to the source entry.

When omitted, Fino generates a unique `fino:realm/source/...` specifier.
Provide an absolute file path or `file://` URL when relative imports inside
the source should resolve from a specific directory.

### sourceMap

```ts
sourceMap?: string
```

Optional source map JSON for the provided source text.

Invalid or empty source maps are ignored by the runtime. The value defaults
to an empty string, matching other source import directives.

## RealmFn

```ts
type RealmFn = (...args: any[]) => any
```

Function shape used by `Realm.call()` and `RealmPool.call()`.

A child entry module should default-export a function compatible with this
type when the parent intends to call it. Arguments and return values must be
supported by the active transport serializer.

```ts
import type { RealmFn } from 'fino:realm';

const worker: RealmFn = (name: string) => `hello ${name}`;
export default worker;
```

## ProcessPort

```ts
class ProcessPort extends BaseTransportPort {
```

ProcessPort wraps the process realm native functions with the same event-loop
integration as ThreadPort: register the wake-fd with loop.readable(), drain
messages on each wake, dispatch as MessageEvents.

Process ports are created by `new Realm({ process: true })`; application code
normally uses the port through `realm.port`. Posting to a closed port is a
no-op. Only transferable `ArrayBuffer` values are extracted from transfer
lists.

```ts
import { Realm } from 'fino:realm';

const realm = new Realm({ entry: './worker.mts', process: true });
realm.port.postMessage({ ready: true });
realm.port.start();
```

### constructor

```ts
constructor(wakeReadFd: number, handle: number)
```

Create a process transport port from native process realm handles.

This constructor is part of the runtime bridge. Prefer constructing a
process realm and using its `port`; invalid handles can break event-loop
integration or fail native sends.

```ts
import { ProcessPort } from 'fino:realm';

const port = new ProcessPort(wakeReadFd, nativeHandle);
port.start();
```

### postMessage

```ts
postMessage(message: any, transferOrOpts?: Transferable[] | StructuredSerializeOptions): void
```

Serialize and send a message to the process realm.

Messages use the runtime serializer. Transfer lists may include
`ArrayBuffer` instances. Other transferable values, including
`MessagePort`, are rejected because process-realm transport cannot move
live in-process handles across the process boundary. Calling after
`close()` returns without sending.

```ts
import { Realm } from 'fino:realm';

const realm = new Realm({ entry: './worker.mts', process: true });
realm.port.postMessage({ job: 'start' });
```

## Realm

```ts
class Realm<F extends RealmFn = RealmFn> {
```

Isolated child realm with its own module graph and communication port.

A realm can run embedded in the current isolate, in a thread, in a process,
or on a remote cluster node. Use `run()` for entry modules with side effects
and `call()` for entry modules that default-export a callable function.

```ts
import { Realm } from 'fino:realm';

const realm = new Realm<(name: string) => string>({ entry: './worker.mts' });
const message = await realm.call('Ana');
realm.terminate();
```

### port

```ts
readonly port: MessagePort | ThreadPort | ProcessPort | ClusterPort
```

Parent-side port for general communication with the child realm.

Embedded realms expose a `MessagePort`, thread realms expose a
`ThreadPort`, process realms expose a `ProcessPort`, and remote realms
expose a `ClusterPort`. Start the port before listening for messages.

```ts
import { Realm } from 'fino:realm';

const realm = new Realm({ entry: './worker.mts' });
realm.port.addEventListener('message', (event) => console.log(event.data));
realm.port.start();
```

### fromSource

```ts
static fromSource<F extends RealmFn = RealmFn>(
  source: string,
  options: RealmSourceOptions = {
  }
): Realm<F>
```

Create a Realm whose entrypoint is in-memory module source.

The source is installed as an import-rule-backed entry module and then
evaluated by the same Realm machinery used for file entries. Caller import
rules, provider overrides, blocked specifiers, and execution mode options
are preserved. Source entries cannot use `watch` because there is no entry
file to monitor for changes.

```ts
import { Realm } from 'fino:realm';

const realm = Realm.fromSource(`
  await Promise.resolve();
  globalThis.value = 42;
`);
await realm.run();
```

### constructor

```ts
constructor(opts: RealmOptions)
```

Create a child realm and its parent-side communication port.

The constructor builds import rules, creates the selected execution mode,
and binds facade RPC dispatchers. It throws for invalid mode combinations,
remote realms without an active cluster, or native creation failures.

```ts
import { ImportMap, Realm } from 'fino:realm';

const realm = new Realm({
  entry: './worker.mts',
  thread: true,
  overrides: ImportMap.inherit([]),
});
```

### run

```ts
run(): Promise<void>
```

Run the child realm to completion.

The returned promise resolves when the child exits cleanly and rejects when
the child reports a runtime error. Watch-mode realms keep the promise
pending across reloads until `terminate()` stops watching.

```ts
import { Realm } from 'fino:realm';

const realm = new Realm({ entry: './worker.mts' });
await realm.run();
```

### call

```ts
call(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>>
```

Call the child Realm's default-exported function with `args`.

The call starts the realm, sends `{ __call: true, args }`, and resolves
with the returned value. It rejects if the realm exits before returning, if
the child serializes a call error, or if the remote cluster reports exit.
The port is closed after the first response for non-streaming calls.

```ts
import { Realm } from 'fino:realm';

const realm = new Realm<(a: number, b: number) => number>({ entry: './add.mts' });
const sum = await realm.call(2, 3);
```

### terminate

```ts
terminate(): void
```

Signal the child realm to stop.

Embedded realms are terminated through the native child handle. Thread,
process, and remote realms receive a `__terminate` message and their
parent-side port is closed. The method is synchronous and does not wait for
`run()` to settle.

```ts
import { Realm } from 'fino:realm';

const realm = new Realm({ entry: './worker.mts', thread: true });
realm.terminate();
```
