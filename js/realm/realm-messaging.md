---
weight: 13
---
# Messaging

Every realm has a parent-side port exposed as `realm.port`. The type depends on the execution mode — `MessagePort` for embedded realms, and transport-backed equivalents for thread, process, and remote realms — but all share the same `addEventListener` / `postMessage` / `start` / `close` interface.

## Parent-side port

Listen for messages from the child and send messages to it through `realm.port`:

```ts
import { Realm } from 'fino:realm';

const realm = new Realm({ entry: './worker.ts' });

realm.port.addEventListener('message', (ev) => {
  console.log('from child:', ev.data);
});
realm.port.start();  // required before messages are delivered
realm.port.postMessage({ type: 'ping' });

await realm.run();
```

Calling `start()` is required to begin receiving messages. As a shortcut, assigning `realm.port.onmessage` starts the port automatically:

```ts
realm.port.onmessage = (ev) => console.log(ev.data);
```

## Child-side port — embedded realms

In an embedded child realm, the child accesses its port from `fino:realm/self`:

```ts
// child entry (embedded realm)
import { port } from 'fino:realm/self';

port?.addEventListener('message', (ev) => {
  port?.postMessage({ echo: ev.data });
});
port?.start();
```

`port` is `undefined` when the child was not given a port at construction time — this is the case for root realms and for thread and process realms. Always guard with `port?.` unless you are certain the child is embedded and was constructed without custom `input`/`output` ports.

## Child-side port — thread and process realms

Thread and process realms do not use `fino:realm/self`. The child accesses its parent-side channel through `globalThis.realmPort`, which is injected by the runtime bootstrap:

```ts
// child entry (thread or process realm)
globalThis.realmPort.addEventListener('message', (ev) => {
  globalThis.realmPort.postMessage({ got: ev.data });
});
globalThis.realmPort.start();
```

This is wired up automatically. The child does not need to import anything to access it.

## Creating new channels

`fino:realm/messaging` re-exports the standard `MessageChannel`, `MessagePort`, and `MessageEvent` types. Use `MessageChannel` when you need a fresh pair of entangled ports:

```ts
import { MessageChannel } from 'fino:realm/messaging';

const { port1, port2 } = new MessageChannel();
// transfer port1 to the child via the existing realm port
realm.port.postMessage('here is your extra channel', [port1]);
```

You can also supply custom ports at realm construction time when you need to manage the channel yourself:

```ts
import { MessageChannel } from 'fino:realm/messaging';

const { port1, port2 } = new MessageChannel();
const realm = new Realm({
  entry: './worker.ts',
  input: port1,   // parent keeps port1
  output: port2,  // child receives port2 (available via fino:realm/self)
});
```

## Transfer rules

What can be included in a `postMessage` transfer list depends on the realm type:

| Realm type | `ArrayBuffer` transfer | `MessagePort` transfer |
| --- | --- | --- |
| Embedded (same-isolate) | Yes — neutered on sender | Yes — neutered on sender, re-entangled on receiver |
| Thread | Yes | Yes |
| Process | Yes | No — throws `TypeError` |
| Remote | No stable contract | No stable contract |

A transferred `ArrayBuffer` is detached on the sending side after `postMessage` returns. A transferred `MessagePort` is neutered on the sender and a new entangled port is installed in the receiver's message event's `ports` array.

Values that the serializer cannot clone — functions, symbols, `WeakMap`, `WeakSet`, and class instances with non-plain prototypes — cause `postMessage` to throw a `DataCloneError` synchronously. This applies to all realm transport types.

## BroadcastChannel

`BroadcastChannel` is a runtime global (no import required) that provides one-to-many pub/sub across realms by channel name:

```ts
// parent realm
const bc = new BroadcastChannel('cache-updates');
bc.postMessage({ key: 'users:42', ts: Date.now() });
bc.close();

// any other realm
const bc = new BroadcastChannel('cache-updates');
bc.onmessage = (ev) => {
  console.log('invalidate', ev.data.key);
};
```

Delivery is asynchronous. The sender does not receive its own messages. `BroadcastChannel` works across embedded, thread, and process realms — the Rust-side broadcast registry fans out serialized bytes to every subscriber on the same channel name.

`BroadcastChannel` does not accept transfer lists. Passing a function or symbol in `postMessage` throws a `DataCloneError` synchronously. Messages that cannot be deserialized on the receiver arrive as `messageerror` events with `data === null`.

Close the channel when done to release the subscription:

```ts
bc.close();
// or use explicit resource management:
using bc = new BroadcastChannel('updates');
```
