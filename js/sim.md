---
weight: 115
---
# Deterministic Simulation

A simulation exposes a realm through supplied facades. Its virtual clock,
seeded randomness, and ordered timers make runs repeatable.

This makes tests reproducible, failures replayable, and guests observable.

```ts
import { simulate } from 'fino:sim';

const report = await simulate({
  entry: './worker.ts',
  seed: 42,
  world: {
    'app:kv': {
      get: async (key: unknown) => `value-for-${String(key)}`,
      set: async () => null,
    },
  },
});

console.log(report.result);
console.log(report.journal.calls('app:kv', 'get').length);
```

## The world is the whole world

A simulated realm starts from a deny-all import map. It can reach the
specifiers in `world` and `grant`, and nothing else.

Ambient I/O is closed at startup. `fetch` requires a `fino:net/fetch` facade;
other network globals throw because no deterministic transport serves them.

`Math.random`, Web Crypto, and `fino:security/random` use the seed. OpenSSL
operations with internal entropy are rejected.

## Faking the network

`FakeNet` answers the guest's ambient `fetch` from a route table, so code that
calls the network needs no injection point to become testable:

```ts
import { FakeNet, simulate } from 'fino:sim';

const net = new FakeNet({
  'https://api.example.com/health': { status: 200, body: '{"ok":true}' },
  'POST https://api.example.com/orders': (request) => ({
    status: 201,
    body: JSON.stringify({ received: request.body?.byteLength ?? 0 }),
  }),
});

const report = await simulate({
  entry: './worker.ts',
  world: { ...net.world() },
});
```

A request matching no route gets a 502.

`FakeFs` is the filesystem equivalent, and it drops in for `fino:file`: a
guest's `import { DiskFileSystem } from 'fino:file'` resolves to a compatible
surface — `FileSystem`, `File` handles, `Stat`, directory entries, symlinks —
whose every operation crosses the facade and lands in the journal. Errno codes
like `ENOENT` survive the crossing, and timestamps count mutations rather than
wall time so equal seeds report equal stats.

```ts
import { FakeFs, simulate } from 'fino:sim';

const fs = new FakeFs({ '/etc/app/config': 'debug=true' });
const report = await simulate({
  entry: './worker.ts',
  world: { ...fs.world() },
});
console.log(fs.snapshot()); // everything the guest wrote
```

Spread mocks together as `world: { ...fs.world(), ...net.world() }`. `FakeFs`
uses [`MemoryFileSystem`](./file/memory.ts), exposed as `fs.filesystem` for
additional setup. `provider()` returns the shape-aware facade directly for
manual import-map composition.

## Virtual time

Timers do not wait. Once real work is exhausted, the realm jumps to the next
deadline:

```ts
// Completes immediately; the guest observes a full day passing.
await new Promise((resolve) => setTimeout(resolve, 86_400_000));
```

`Date.now()`, `new Date()`, and `performance.now()` all read the virtual clock.
Pass `realTime: true` to keep the clock real while leaving randomness seeded.

## Recording and replay

A cassette stores the ordered realm-channel frames as structured-clone bytes,
so `Map`, `Set`, `Date`, `BigInt`, typed arrays, and cycles survive a round
trip. Its manifest fixes the entry, effective import map, runtime, seed, clock,
latency, and hashes of every file in the loaded module graph:

```ts
const recorded = await simulate({
  entry: './worker.ts',
  world,
  cassette: { mode: 'record' },
});

const replayed = await simulate({
  entry: './worker.ts',
  world,
  cassette: { mode: 'replay', data: recorded.cassette },
});
```

Replay serves recorded answers without consulting providers and reports the
first divergent call.

Deterministic realms also send bootstrap data, console lines, telemetry, and
lifecycle records through the session. Live `MessagePort` transfer and nested
realms are rejected because either would create a channel that a portable
cassette cannot represent. `ArrayBuffer` transfer remains supported; recorder
copies are made only when storage capture is active.

## Faults and sweeps

Failures are injected from a generator seeded by the run's seed and consulted in
call order, so a given seed always fails the same calls:

```ts
import { sweep } from 'fino:sim';

const outcomes = await sweep({ entry: './worker.ts', world, faults: { errorRate: 0.3 } }, 100);
const failing = outcomes.filter((outcome) => outcome.error !== undefined);
console.log(failing.map((outcome) => outcome.seed));
```

A failing seed can be passed back to `simulate()` to reproduce it.

Responses can also be given latency, charged to the virtual clock:

```ts
await simulate({
  entry: './worker.ts',
  world,
  faults: { latency: [10, 500] },
});
```

Latency costs no real time, but allows timers to overtake responses. It uses a
separate seeded generator, preserves stream chunk order, and applies no extra
delay to end-of-stream.

## What stays nondeterministic

- **Read streams hold nothing.** The parent still decides when chunks exist;
  `faults.latency` only shapes when the guest sees them.
- **`SharedArrayBuffer` is unavailable** inside a simulated realm. Shared memory
  is written outside the simulation and would not replay, so the constructor
  throws rather than letting a run record something it cannot reproduce.
- **Facade errors** cross as strings, without stacks, classes, or `cause`.
- **GC timing**, `WeakRef`, and `FinalizationRegistry` are outside the model.

## In tests

`fino:test/sim` ties a cassette to the test that owns it — record on the first
run and replay afterwards. Delete the cassette to re-record, or pass
`noCassette` to run against the live world.

## Relationship to realms

A simulation is an ordinary realm with `sim` set, so everything in the
[Realms section](./realm.md) applies: the same import rules, the same facade
mechanism, the same messaging. `simulate()` is the harness that assembles those
pieces, and `RealmOptions.sim` is available directly when you want to build the
realm yourself.

Simulation is intentionally local. `sim` with `remote: true` is rejected rather
than expanding the cluster protocol and transport lifecycle into this feature.
