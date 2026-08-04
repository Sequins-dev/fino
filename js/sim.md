---
weight: 115
---
# Deterministic Simulation

A simulation runs code in a realm whose entire contact with the outside world is
a set of facades you supply. Inside that realm the clock is virtual, every
random source is seeded, and timers fire in deadline order — so two runs of the
same simulation execute identically, producing the same values, the same
interleaving, and the same sequence of calls out.

One property, three uses:

- **Tests that involve time, randomness, or I/O become reproducible.** A retry
  with exponential backoff is tested in microseconds instead of being skipped
  for being slow.
- **A failure becomes replayable.** Record a run to a cassette and play it back;
  a seed alone reproduces a failing schedule.
- **Unknown code becomes observable.** The journal records every call it makes
  to the simulated world.

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

Ambient I/O is closed at simulation startup. `fetch` can only call a facade at
`fino:net/fetch`; `WebSocket`, `WebTransport`, `EventSource`, and
`BroadcastChannel` throw because no deterministic transport is defined for
them. A guest with no corresponding world entry therefore has no network path.

Random bytes used by `Math.random`, Web Crypto, and `fino:security/random` come
from the seed. Crypto operations whose entropy is internal to OpenSSL, such as
EC/RSA key generation, are rejected instead of silently breaking determinism.

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

A request matching no route gets a 502, so a guest reaching somewhere the
simulation did not describe fails loudly rather than silently succeeding.

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

`world()` is what every mock exposes. Spread as many as you need:
`world: { ...fs.world(), ...net.world() }`. `FakeFs` places a shape-aware
facade directly at `fino:file`, so the import map has no secondary guest module
or redirection to keep in sync.

Behind `FakeFs` is an ordinary [`MemoryFileSystem`](./file/memory.ts) from
`fino:file/memory`, reachable as `fs.filesystem` for setup the constructor
cannot express:

```ts
const fs = new FakeFs({ '/real/app.conf': 'debug=true' });
await fs.filesystem.mkdir('/var');
await fs.filesystem.symlink('/real/app.conf', '/etc/app.conf');
```

That same class is a plain `fino:file` provider usable outside a simulation
entirely, wherever a test wants a filesystem without a temp directory.

`FakeFs.provider()` returns that facade directly when you need to compose the
import rule yourself.

## Virtual time

Timers do not wait. A simulated realm advances its clock only once it has run
out of real work, then jumps straight to the next deadline:

```ts
// Completes immediately; the guest observes a full day passing.
await new Promise((resolve) => setTimeout(resolve, 86_400_000));
```

`Date.now()`, `new Date()`, and `performance.now()` all read the virtual clock.
Time does not advance while the guest is waiting on a facade response, so a
timer can never be observed overtaking a reply depending on how long the parent
really took.

Pass `realTime: true` to keep the clock real while leaving randomness seeded.

## Recording and replay

A cassette stores what crossed the boundary as structured-clone bytes, so
`Map`, `Set`, `Date`, `BigInt`, typed arrays, and cycles survive a round trip:

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

During replay the providers are not consulted; recorded answers are served in
order. If the guest makes a different call than the recording expects, the run
fails and names the first divergence — which makes a cassette a behavioural
assertion, not just a fixture.

## Faults and sweeps

Failures are injected from a generator seeded by the run's seed and consulted in
call order, so a given seed always fails the same calls:

```ts
import { sweep } from 'fino:sim';

const outcomes = await sweep({ entry: './worker.ts', world, faults: { errorRate: 0.3 } }, 100);
const failing = outcomes.filter((outcome) => outcome.error !== undefined);
console.log(failing.map((outcome) => outcome.seed));
```

Where a single run answers "does this work", a sweep answers "for which
schedules does this work". A failing seed is a complete reproduction: pass it
back to `simulate()` to get the same failure again.

Responses can also be given latency, charged to the virtual clock:

```ts
await simulate({
  entry: './worker.ts',
  world,
  faults: { latency: [10, 500] },
});
```

A simulated 500ms round trip costs nothing in real time. What it does cost is
the assumption that replies arrive instantly — with latency, a timer scheduled
before a call can fire before the response comes back, which is the ordering
bug that an instant fake world hides. Delays are drawn from a generator seeded
separately from the guest's own randomness, so adding latency does not shift the
values the guest draws.

Read-stream chunks are delayed the same way: each chunk draws its own latency in
arrival order, and deliveries are chained per stream so a short delay never lets
a later chunk overtake an earlier one. End-of-stream draws no delay of its own —
it is the FIN riding behind the last chunk — but queues behind the chunks in
flight.

## What stays nondeterministic

- **Read streams hold nothing.** A subscription stays open for as long as the
  guest iterates it, so virtual time is not held while one is open; the parent
  decides when chunks exist, and `faults.latency` only shapes when the guest
  sees them.
- **`SharedArrayBuffer` is unavailable** inside a simulated realm. Shared memory
  is written outside the simulation and would not replay, so the constructor
  throws rather than letting a run record something it cannot reproduce.
- **Facade errors** are stringified as they cross the boundary, so stacks,
  custom error classes, and `cause` do not survive — with or without a journal.
- **GC timing**, `WeakRef`, and `FinalizationRegistry` are outside the model.

## In tests

`fino:test/sim` ties a cassette to the test that owns it — record on the first
run, replay on every run after, fail on divergence:

```ts
import { describe, it } from 'fino:test/test';
import { simulated } from 'fino:test/sim';

describe('checkout', () => {
  it('charges once', async (t) => {
    const report = await simulated(t, {
      entry: './checkout.ts',
      world: { 'app:payments': { charge: async () => ({ ok: true }) } },
    });
    t.equal(report.journal.calls('app:payments', 'charge').length, 1);
  });
});
```

Delete the cassette file to re-record it, or pass `noCassette` to always run
against the live world.

## Relationship to realms

A simulation is an ordinary realm with `sim` set, so everything in the
[Realms section](./realm.md) applies: the same import rules, the same facade
mechanism, the same messaging. `simulate()` is the harness that assembles those
pieces, and `RealmOptions.sim` is available directly when you want to build the
realm yourself.

Simulation is intentionally local. `sim` with `remote: true` is rejected rather
than expanding the cluster protocol and transport lifecycle into this feature.
