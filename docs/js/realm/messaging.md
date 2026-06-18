# messaging

fino:realm/messaging - MessagePort, MessageChannel, MessageEvent.

Standard WHATWG messaging API. Use `MessageChannel` to create a pair of
entangled ports for bidirectional communication between realms. `MessagePort`
values use structured clone semantics for same-isolate realms and transport
serialization for thread, process, and remote realm ports.

```ts
import { MessageChannel } from 'fino:realm/messaging';
import { Realm } from 'fino:realm';

const channel = new MessageChannel();
const realm = new Realm({
  entry: './worker.mts',
  input: channel.port1,
  output: channel.port2,
});
realm.port.postMessage({ hello: true });
```
