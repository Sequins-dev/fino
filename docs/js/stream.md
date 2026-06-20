# js/stream

fino:stream — generic, byte-specialized, and buffered async I/O abstractions.

This public facade re-exports the stream primitives implemented by
`internal:stream` so application code and internal modules share the same
class identities. Use these classes when building custom byte readers,
coalescing writers, or fd-backed adapters.

```ts
import { BufferedBytesReader, BytesReader } from 'fino:stream';

class EmptyBytes extends BytesReader {
  protected async doRead() {
    return null;
  }
}

const reader = BufferedBytesReader.over(new EmptyBytes());
console.log(await reader.peek(1));
```
