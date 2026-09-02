---
weight: 16
---
# Readers, Writers, and Channels

Fino models streaming as value delivery with back-pressure. A `Reader<T>` is
the pull side and a `Writer<T>` is the acceptance side. The two endpoints are
small facades over shared state; that state owns ordering, capacity, closure,
and failure. Callers only use `read()`, `write()`, `flush()`, and `close()`.

Every direct read returns an iterator-shaped result:

```ts no_run
const result = await reader.read();
if (result.done) {
  // Clean end of stream.
} else {
  use(result.value);
}
```

This makes every `T` deliverable, including `null` and `undefined`, without an
out-of-band sentinel. It is also the same shape used by `for await`, so direct
pulls and async iteration express completion identically.

This separation matters for I/O. A socket receive path can own a private byte
state and feed it from `read(2)` while exposing only its `Reader<Uint8Array>`.
The transmit path can expose only a `Writer<ArrayBuffer | ArrayBufferView>` and
let its private state drive `write(2)`. A duplex socket composes one state in
each direction. There is no synthetic public writer for incoming bytes and no
synthetic public reader for outgoing bytes.

## Typed channels

`Channel<T>` connects a `Writer<T>` to a `Reader<T>` with zero capacity. A
write stays pending until a read accepts the value, so producer speed follows
consumer demand. Reads and writes are paired in call order.

```ts no_run
import { Channel } from 'fino:stream';

const channel = new Channel<string>();
const consumer = (async () => {
  for await (const value of channel.reader) console.log(value);
})();

await channel.writer.write('first');
await channel.writer.write('second');
await channel.writer.close();
await consumer;
```

Use `UnboundedChannel<T>` when the producer must be allowed to run ahead. Its
linked buffer grows until the reader catches up, so it trades back-pressure for
potentially unbounded memory use. It should be an explicit choice rather than
the default channel behavior.

## Transform values with async iterables

A channel delivers values; it does not transform one type into another.
Transforms belong outside the delivery mechanism and compose naturally as
async generators. `Reader.from()` turns the resulting async iterable back into
a `Reader` when an endpoint API is useful.

```ts no_run
import { Channel, Reader } from 'fino:stream';

async function* lengths(source: AsyncIterable<string>) {
  for await (const value of source) yield value.length;
}

const input = new Channel<string>();
const output: Reader<number> = Reader.from(lengths(input.reader));
```

Keeping transformation external means the same channel state can deliver any
`T`, while mapping, filtering, decoding, framing, and protocol parsing remain
ordinary composable JavaScript.

## Byte readers and writers

`BytesReader` and `BytesWriter` specialize the generic endpoints with byte
operations. A byte write does not imply one equally sized byte read. Readers
can request a bounded chunk, exactly N bytes, one byte, or bytes through a
delimiter; `readInto(buffer)` fills reusable caller storage and reports the
number of bytes written in a `ReadResult<number>`. Writers accept any
`ArrayBuffer` or view. The byte
state preserves the byte sequence while satisfying those independently sized
operations.

This is different from a typed `Channel<T>`, where each write delivers one
value. Byte state treats input as a continuous ordered sequence.

`BytesChannel` is the zero-capacity byte form. It owns no byte storage.
`readInto(view)` offers that exact view to the producer; the producer's
`reserve()` waits for it and returns the same backing buffer, offset, and
length. `commit(n)` completes the read with the filled prefix. The ordinary
`read(n)` method is sugar over this mechanism: it allocates `n` bytes, offers
that allocation to the producer, and returns a view ending at the committed
length. A producer therefore cannot run ahead of demand on an unbuffered byte
channel.

## Buffered I/O state

Buffering is a state policy at an I/O boundary, not a transform-stream
feature. `BufferedBytesChannel` owns one capacity-sized `ArrayBuffer` segment.
`UnboundedBytesChannel` uses the same endpoint contract but may append more
capacity-sized segments whenever its producer runs ahead. An input driver can
fill these segments directly from a file descriptor and let protocol code
consume differently sized views. Capacity is measured in bytes:

- an input driver stops reading when the high-water capacity is occupied and
  resumes after consumption reaches its low-water point;
- a public write resolves only when the state has accepted all of its bytes;
- a requested read resolves when enough bytes are present, or returns the
  remaining bytes when the source reaches EOF;
- closing and failure wake both sides without changing accepted byte order.

I/O drivers should fill storage reserved from their private state directly.
For a buffered state, `reserve()` returns an entire capacity-sized segment and
`commit(n)` publishes only its filled prefix. For an unbuffered state,
`reserve()` instead waits for and returns the exact view offered by
`readInto()`. These driver operations remain internal state mechanics rather
than additional methods on the public `Reader` or `Writer` facade. Closing a
state releases an uncommitted reservation without publishing it.

`read(n)` always returns stable caller-owned bytes. It allocates an `n`-byte
destination, reads into it, and returns the filled prefix as the result value;
later channel
operations cannot mutate that result. `readInto(view)` instead borrows the
caller's exact view only until its promise settles. It copies buffered bytes
into that storage and can consume across multiple segments immediately, which
is preferable when the caller manages an arena or buffer pool.

The transfer size should be large enough to amortize syscall overhead, while
capacity limits total resident data so many concurrent connections can retain
throughput. These are separate choices: transfer size controls each I/O
attempt; capacity controls aggregate buffering and back-pressure.

Most protocol layers should therefore remain unbuffered async-iterable
transforms over memory already admitted by the I/O state. Buffer once at the
resource boundary, then compose pull-driven processing downstream.

## Directional closure

`writer.close()` is clean completion. It rejects new writes, lets committed
values or bytes drain in FIFO order, and only then completes; subsequent reads
return `{ done: true, value: undefined }`. `writer.close(error)` follows the
same drain rule, then rejects the next read with that error instead of
reporting clean completion. There is no separate failure method because an
error still terminates the writer.

`reader.close()` is clean early cancellation by the consumer. Pending and
future reads complete as done, while blocked and future producer operations
reject with `ChannelCancelledError`. `reader.close(error)` uses the same
directional cancellation but rejects pending reads and propagates that exact
error to the writer. Buffered data that the reader abandons is discarded; any
writer close still waiting for it to drain rejects with the cancellation.

An uncommitted reserved byte region is never data. Closing the writer releases
it, and `commit(0)` publishes neither a value nor EOF; the read remains pending
for a later non-empty commit or terminal close.
