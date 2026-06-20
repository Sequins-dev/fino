# js/internal/net/http/h3/bindings

## h3Available

```ts
const h3Available
```

## requireH3

```ts
function requireH3(): ReturnType<typeof dlopen>
```

## sym

```ts
const sym
```

## NGHTTP3_CALLBACKS_VERSION

```ts
const NGHTTP3_CALLBACKS_VERSION
```

## NGHTTP3_SETTINGS_VERSION

```ts
const NGHTTP3_SETTINGS_VERSION
```

## CB_SIZE

```ts
const CB_SIZE
```

## CB_ACKED_STREAM_DATA

```ts
const CB_ACKED_STREAM_DATA
```

## CB_STREAM_CLOSE

```ts
const CB_STREAM_CLOSE
```

## CB_RECV_DATA

```ts
const CB_RECV_DATA
```

## CB_DEFERRED_CONSUME

```ts
const CB_DEFERRED_CONSUME
```

## CB_BEGIN_HEADERS

```ts
const CB_BEGIN_HEADERS
```

## CB_RECV_HEADER

```ts
const CB_RECV_HEADER
```

## CB_END_HEADERS

```ts
const CB_END_HEADERS
```

## CB_BEGIN_TRAILERS

```ts
const CB_BEGIN_TRAILERS
```

## CB_RECV_TRAILER

```ts
const CB_RECV_TRAILER
```

## CB_END_TRAILERS

```ts
const CB_END_TRAILERS
```

## CB_STOP_SENDING

```ts
const CB_STOP_SENDING
```

## CB_END_STREAM

```ts
const CB_END_STREAM
```

## CB_RESET_STREAM

```ts
const CB_RESET_STREAM
```

## CB_SHUTDOWN

```ts
const CB_SHUTDOWN
```

## NV_ENTRY_SIZE

```ts
const NV_ENTRY_SIZE
```

## NV_NAME

```ts
const NV_NAME
```

## NV_VALUE

```ts
const NV_VALUE
```

## NV_NAMELEN

```ts
const NV_NAMELEN
```

## NV_VALUELEN

```ts
const NV_VALUELEN
```

## NV_FLAGS

```ts
const NV_FLAGS
```

## NGHTTP3_NV_FLAG_NONE

```ts
const NGHTTP3_NV_FLAG_NONE
```

## NGHTTP3_NV_FLAG_NEVER_INDEX

```ts
const NGHTTP3_NV_FLAG_NEVER_INDEX
```

## VEC_ENTRY_SIZE

```ts
const VEC_ENTRY_SIZE
```

## VEC_BASE

```ts
const VEC_BASE
```

## VEC_LEN

```ts
const VEC_LEN
```

## DR_READ_DATA

```ts
const DR_READ_DATA
```

## DR_SIZE

```ts
const DR_SIZE
```

## SETTINGS_SIZE

```ts
const SETTINGS_SIZE
```

## NGHTTP3_DATA_FLAG_EOF

```ts
const NGHTTP3_DATA_FLAG_EOF
```

## NGHTTP3_DATA_FLAG_NO_END_STREAM

```ts
const NGHTTP3_DATA_FLAG_NO_END_STREAM
```

## NGHTTP3_H3_NO_ERROR

```ts
const NGHTTP3_H3_NO_ERROR
```

## NGHTTP3_H3_GENERAL_PROTOCOL_ERROR

```ts
const NGHTTP3_H3_GENERAL_PROTOCOL_ERROR
```

## NGHTTP3_H3_INTERNAL_ERROR

```ts
const NGHTTP3_H3_INTERNAL_ERROR
```

## NGHTTP3_H3_REQUEST_CANCELLED

```ts
const NGHTTP3_H3_REQUEST_CANCELLED
```

## NGHTTP3_H3_REQUEST_INCOMPLETE

```ts
const NGHTTP3_H3_REQUEST_INCOMPLETE
```

## NGHTTP3_ERR_WOULDBLOCK

```ts
const NGHTTP3_ERR_WOULDBLOCK
```

## NGHTTP3_ERR_MALFORMED_HTTP_HEADER

```ts
const NGHTTP3_ERR_MALFORMED_HTTP_HEADER
```

## NGHTTP3_ERR_MALFORMED_HTTP_MESSAGING

```ts
const NGHTTP3_ERR_MALFORMED_HTTP_MESSAGING
```

## NGHTTP3_ERR_FATAL

```ts
const NGHTTP3_ERR_FATAL
```

## NGHTTP3_H3_MESSAGE_ERROR

```ts
const NGHTTP3_H3_MESSAGE_ERROR
```

## readCStr

```ts
function readCStr(ptr: ArrayBuffer): string
```

## encodeUtf8

```ts
function encodeUtf8(s: string): Uint8Array
```

## readRcbuf

```ts
function readRcbuf(rcbufPtr: ArrayBuffer): string
```

## buildNvArray

```ts
function buildNvArray(headers: Array<[string, string]>): {
  buf: Uint8Array;
  nv: number;
}
```

## writeCbPtr

```ts
function writeCbPtr(buf: Uint8Array, offset: number, cb: {
  pointer: ArrayBuffer;
}): void
```
