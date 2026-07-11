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

The scheduler begins allocation during construction. `run()` settles when the
entry module and its referenced work finish, and rejects on an uncaught entry
error. `Realm.fromSource()` provides the same behavior for in-memory TypeScript;
source realms cannot use watch mode.

## Repeated calls and scaling

If the entry default-exports a function, `call()` invokes it. Calls are
correlated and one `Realm` may be called repeatedly.

```ts
const realm = new Realm<(name: string) => Promise<string>>({
  entry: './worker.ts',
  scaling: { min: 1, max: 4 },
});

const [a, b] = await Promise.all([realm.call('Ana'), realm.call('Bo')]);
```

Replicated realms may add isolates when queued calls remain unhealthy. Each
replica has an independent heap. Use `scaling: { mode: 'bound' }` when calls
must share one private heap. Availability minima warm eagerly; quiet excess
replicas drain after the scale-down window.

## Idle liveness

Logical realms are unreferenced by default. After their active calls finish,
idle replicas may drain and a later call reconstructs capacity.

```ts
realm.ref();    // keep the availability minimum warm
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
`terminate()` is called. Watch mode works on scheduler reactors and with
process isolation; it is unavailable for `Realm.fromSource()`.
