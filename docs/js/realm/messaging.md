# js/realm/messaging

fino:realm/messaging — MessagePort, MessageChannel, MessageEvent.

Standard WHATWG messaging API. Use MessageChannel to create a pair of
entangled ports for bidirectional communication between Realms.

## MessagePort

```ts
class MessagePort extends EventTarget {
```

### postMessage

```ts
postMessage(message: any, transfer?: Transferable[]): void
```

### postMessage

```ts
postMessage(message: any, options?: StructuredSerializeOptions): void
```

### postMessage

```ts
postMessage(message: any, transferOrOpts?: Transferable[] | StructuredSerializeOptions): void
```

### start

```ts
start(): void
```

### close

```ts
close(): void
```

### onmessage

```ts
get onmessage()
```

### onmessage

```ts
set onmessage(fn: ((ev: MessageEvent) => void) | null)
```

### onmessageerror

```ts
get onmessageerror()
```

### onmessageerror

```ts
set onmessageerror(fn: ((ev: MessageEvent) => void) | null)
```

## MessageChannel

```ts
class MessageChannel {
```

### port1

```ts
readonly port1: MessagePort
```

### port2

```ts
readonly port2: MessagePort
```

### constructor

```ts
constructor()
```

## MessageEvent

```ts
class MessageEvent extends Event {
```

### constructor

```ts
constructor(type: string, init?: MessageEventInit)
```

### data

```ts
get data()
```

### origin

```ts
get origin()
```

### lastEventId

```ts
get lastEventId()
```

### source

```ts
get source()
```

### ports

```ts
get ports()
```
