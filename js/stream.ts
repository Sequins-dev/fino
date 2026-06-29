/**
* fino:stream — generic, byte-specialized, and buffered async I/O abstractions.
*
* This public facade re-exports the stream primitives implemented by
* `internal:stream` so application code and internal modules share the same
* class identities. Use these classes when building custom byte readers,
* coalescing writers, or fd-backed adapters.
*
* `FdReader` and `FdWriter` borrow nonblocking POSIX descriptors. They retry
* short reads/writes and wait through `EAGAIN` with the runtime platform loop
* hooks (`kqueue`, `epoll`, or the active backend) before attempting more I/O.
* The caller-owned close callback is responsible for descriptor shutdown.
*
* ```ts no_run
* import { BufferedBytesReader, BytesReader } from 'fino:stream';
*
* class EmptyBytes extends BytesReader {
*   protected async doRead() {
*     return null;
*   }
* }
*
* const reader = BufferedBytesReader.over(new EmptyBytes());
* console.log(await reader.peek(1));
* ```
*/
export * from 'internal:stream';
