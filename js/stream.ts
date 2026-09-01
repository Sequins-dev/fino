/**
 * fino:stream — channel-backed readers, writers, and byte I/O endpoints.
 *
 * This public facade re-exports the stream primitives implemented by
 * `internal:stream` so application code and internal modules share the same
 * class identities. Reader and Writer are stable endpoint facades; their
 * shared state owns delivery order, back-pressure, closure, and failure.
 * Channel is a zero-capacity rendezvous, while UnboundedChannel is the
 * explicit producer-ahead specialization. Transform values with async
 * iterables and wrap the result with Reader.from().
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
 *   protected async doReadInto() {
 *     return null;
 *   }
 * }
 *
 * const reader = BufferedBytesReader.over(new EmptyBytes());
 * console.log(await reader.peek(1));
 * ```
 */
export {
  BufferedBytesChannel,
  BufferedBytesReader,
  BufferedBytesWriter,
  BytesReader,
  BytesChannel,
  BytesWriter,
  Channel,
  ChannelCancelledError,
  FdReader,
  FdWriter,
  Reader,
  UnboundedBytesChannel,
  UnboundedChannel,
  Writer,
} from 'internal:stream';
export type {
  BytesReadOptions,
  ReaderCloseCallback,
  ReadResult,
  WriterCloseCallback,
} from 'internal:stream';
