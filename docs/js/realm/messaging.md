# js/realm/messaging

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

## MessagePort

```ts
class MessagePort extends EventTarget {
```

MessagePort for same-isolate and transit cross-isolate messaging.

Same-isolate messages are structured-cloned into the partner queue. Transit
mode serializes messages through the runtime serializer and wake pipes.

```typescript
const { port1, port2 } = new MessageChannel();
port2.onmessage = (event) => console.log(event.data);
port1.postMessage('hello');
```

### postMessage

```ts
postMessage(message: any, transferOrOpts?: Transferable[] | StructuredSerializeOptions): void
```

Send a message to the entangled partner.

Closed or neutered ports silently ignore sends. Transfer lists may contain
ArrayBuffers and MessagePorts. MessagePorts are neutered at the sending
side and reconstructed for the receiver.

```typescript
const { port1, port2 } = new MessageChannel();
port2.start();
port1.postMessage({ ok: true });
```

### start

```ts
start(): void
```

Begin dispatching queued messages.

Setting onmessage also starts the port. Repeated calls are no-ops.

```typescript
const channel = new MessageChannel();
channel.port1.start();
```

### close

```ts
close(): void
```

Close this port and release runtime read watchers.

After close(), postMessage is ignored and pending same-isolate messages are
not dispatched.

```typescript
const channel = new MessageChannel();
channel.port1.close();
```

### onmessage

```ts
get onmessage()
```

Message event handler property.

Assigning a function registers it as a message listener and starts the
port. Assigning null clears the previous handler.

```typescript
const channel = new MessageChannel();
channel.port2.onmessage = (event) => console.log(event.data);
```

### onmessage

```ts
set onmessage(fn: ((ev: MessageEvent) => void) | null)
```

Set or clear the message handler property.

```typescript
const channel = new MessageChannel();
channel.port2.onmessage = null;
```

### onmessageerror

```ts
get onmessageerror()
```

Message error handler property.

```typescript
const channel = new MessageChannel();
channel.port2.onmessageerror = (event) => console.log(event.data);
```

### onmessageerror

```ts
set onmessageerror(fn: ((ev: MessageEvent) => void) | null)
```

Set or clear the messageerror handler property.

```typescript
const channel = new MessageChannel();
channel.port2.onmessageerror = null;
```

## MessageChannel

```ts
class MessageChannel {
```

Pair of entangled MessagePort endpoints.

```typescript
const channel = new MessageChannel();
channel.port1.postMessage('hello');
```

### port1

```ts
readonly port1: MessagePort
```

First endpoint of the channel.

```typescript
const channel = new MessageChannel();
channel.port1.start();
```

### port2

```ts
readonly port2: MessagePort
```

Second endpoint of the channel.

```typescript
const channel = new MessageChannel();
channel.port2.start();
```

### constructor

```ts
constructor()
```

Create two entangled MessagePort instances.

```typescript
const { port1, port2 } = new MessageChannel();
```

## MessageEvent

```ts
class MessageEvent extends Event {
```

Event subclass used for message and messageerror delivery.

Data defaults to null, string fields default to empty string, source defaults
to null, and ports is a frozen copy of the supplied array.

```typescript
const event = new MessageEvent('message', { data: 'hello' });
event.data; // "hello"
```

### constructor

```ts
constructor(type: string, init?: MessageEventInit)
```

Create a MessageEvent.

The event type is usually "message" or "messageerror".

```typescript
new MessageEvent('message', { data: 1 }).type; // "message"
```

### data

```ts
get data()
```

Message payload.

```typescript
new MessageEvent('message', { data: 1 }).data; // 1
```

### origin

```ts
get origin()
```

Origin string for compatibility with browser MessageEvent.

```typescript
new MessageEvent('message').origin; // ""
```

### lastEventId

```ts
get lastEventId()
```

Last event id string.

```typescript
new MessageEvent('message').lastEventId; // ""
```

### source

```ts
get source()
```

Source MessagePort or null.

```typescript
new MessageEvent('message').source; // null
```

### ports

```ts
get ports()
```

Frozen transferred ports array.

```typescript
const ports = new MessageEvent('message').ports;
ports.length; // 0
```
