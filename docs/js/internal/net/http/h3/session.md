# js/internal/net/http/h3/session

## H3SessionCallbacks

```ts
interface H3SessionCallbacks {
```

### onBeginHeaders

```ts
onBeginHeaders(streamId: bigint): void
```

### onRecvHeader

```ts
onRecvHeader(streamId: bigint, token: number, name: string, value: string, flags: number): void
```

### onEndHeaders

```ts
onEndHeaders(streamId: bigint, fin: boolean): void
```

### onBeginTrailers

```ts
onBeginTrailers(streamId: bigint): void
```

### onRecvTrailer

```ts
onRecvTrailer(streamId: bigint, token: number, name: string, value: string, flags: number): void
```

### onEndTrailers

```ts
onEndTrailers(streamId: bigint, fin: boolean): void
```

### onRecvData

```ts
onRecvData(streamId: bigint, data: Uint8Array): void
```

### onEndStream

```ts
onEndStream(streamId: bigint): void
```

### onStreamClose

```ts
onStreamClose(streamId: bigint, appErrorCode: bigint): void
```

### onResetStream

```ts
onResetStream(streamId: bigint, appErrorCode: bigint): void
```

### onAckedStreamData

```ts
onAckedStreamData(streamId: bigint, datalen: bigint): void
```

### onShutdown

```ts
onShutdown?(lastStreamId: bigint): void
```

## Nghttp3Session

```ts
class Nghttp3Session {
```

### createServer

```ts
static createServer(cb: H3SessionCallbacks): Nghttp3Session
```

### createClient

```ts
static createClient(cb: H3SessionCallbacks): Nghttp3Session
```

### bindControlStream

```ts
bindControlStream(controlStreamId: bigint): void
```

### bindQpackStreams

```ts
bindQpackStreams(qencId: bigint, qdecId: bigint): void
```

### addQuicStream

```ts
addQuicStream(streamId: bigint, writer: {
  write(b: Uint8Array): Promise<void>;
  close(): Promise<void>;
}): void
```

### submitResponse

```ts
submitResponse(
  streamId: bigint,
  headers: Array<[string, string]>,
  body?: Uint8Array,
  trailers?: Array<[string, string]>
): void
```

### submitRequest

```ts
submitRequest(
  streamId: bigint,
  headers: Array<[string, string]>,
  body?: Uint8Array,
  trailers?: Array<[string, string]>
): void
```

### submitTrailers

```ts
submitTrailers(streamId: bigint, trailers: Array<[string, string]>): void
```

### readStream

```ts
async readStream(streamId: bigint, data: Uint8Array, fin: boolean): Promise<void>
```

### drainWrites

```ts
async drainWrites(): Promise<void>
```

### isClosed

```ts
get isClosed(): boolean
```

### closeWhenIdle

```ts
closeWhenIdle(): Promise<void>
```

### close

```ts
close(): void
```
