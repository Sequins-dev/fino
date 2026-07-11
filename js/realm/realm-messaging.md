---
weight: 13
---
# Messaging

Every Realm exposes a stable parent-side `realm.port`. Scheduler reactors use a
transit-backed `ThreadPort`; process-isolated realms use `ProcessPort`. Both
provide `addEventListener`, `postMessage`, `start`, `close`, and `onmessage`.

```ts
const realm = new Realm({ entry: './worker.ts' });
realm.port.onmessage = (event) => console.log(event.data);
realm.port.postMessage({ type: 'ping' });
```

Inside a scheduled or process-isolated realm, the runtime exposes the matching
endpoint as `globalThis.realmPort`:

```ts
globalThis.realmPort.onmessage = (event) => {
  globalThis.realmPort.postMessage({ echo: event.data });
};
```

The public port identity remains stable when an idle realm is rehydrated or a
watch reload replaces its isolate.

`ArrayBuffer` transfer is supported by reactor ports. Process transport copies
buffers and does not support live `MessagePort` transfer. Unsupported values
such as functions, symbols, and weak collections throw `DataCloneError`.

`BroadcastChannel` provides named one-to-many delivery across local realms and
process realms. It does not accept transfer lists. Close channels when they are
no longer needed.
