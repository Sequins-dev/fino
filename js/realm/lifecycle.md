---
weight: 11
---
# Realm Lifecycle

## Create and run

```ts
import { Realm } from 'fino:realm';

const realm = new Realm({ entry: './worker.ts' });
await realm.run();
```

Node orchestration begins allocation during construction. The chosen reactor
constructs and schedules exactly one execution container. `run()` settles when
the entry module and its referenced work finish, and rejects on an uncaught
entry error. `Realm.fromSource()` provides the same behavior for in-memory
TypeScript; source realms cannot use watch mode.

## Repeated calls

If the entry default-exports a function, `call()` invokes it. Calls are
correlated and one `Realm` may be called repeatedly. Every call reaches the
same physical realm and therefore observes the same module heap.

```ts
const realm = new Realm<(name: string) => Promise<string>>({
  entry: './worker.ts',
});

const [a, b] = await Promise.all([realm.call('Ana'), realm.call('Bo')]);
```

## Deployments and scaling

Use `RealmDeployment` when work may run on independent replicas. Its `call()`
method admits one call to an available replica. Sustained queue pressure adds a
replica up to `max`; idle excess replicas retire after the scale-down window.

```ts
import { RealmDeployment } from 'fino:realm';

const workers = new RealmDeployment<(name: string) => Promise<string>>({
  entry: './worker.ts',
  scaling: { min: 1, max: 4 },
});

const [a, b] = await Promise.all([workers.call('Ana'), workers.call('Bo')]);
```

Each replica has an independent heap. `connect()` reserves one replica for an
affine session, while `broadcast()` sends a message to every ready replica.
Process isolation remains a one-to-one `Realm` feature and is not supported by
`RealmDeployment`.

## Idle liveness

Realms and deployments are referenced by default. Natural completion still
lets a realm exit; the reference controls whether otherwise-idle call capacity
is kept warm. After `unref()`, idle capacity may drain and a later call can
reconstruct it.

```ts
realm.ref();    // keep idle capacity warm
realm.unref();  // allow idle capacity to expire
realm.hasRef();
```

Active calls and `run()` retain their own work independently of this flag.

## Termination

`terminate()` synchronously requests shutdown; it does not wait for the isolate
or process to finish. Explicit resource management calls it automatically:

```ts
{
  using realm = new Realm({ entry: './worker.ts' });
  await realm.call(payload);
}
```

## Watch mode

`watch: true` keeps the logical Realm stable while replacing its isolate after
an imported file changes. `run()` stays pending across reloads until
`terminate()` is called. Watch mode works on reactor-hosted realms and with
process isolation; it is unavailable for `Realm.fromSource()`.
