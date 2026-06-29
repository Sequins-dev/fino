/**
* Fixture: exercises a Facade sendStream method (write stream, child→parent).
*
* The parent registers a `writeChunks(key)` sink that accumulates chunks
* and returns the total byte count.  The fixture writes three chunks
* without awaiting each one (fire-and-forget), then awaits the final result.
*/
import { writeChunks } from 'fino:test-facade';
export default async function(): Promise<unknown> {
  // callSink returns a WriteSink immediately — no round-trip per write.
  const sink = writeChunks('my-stream');
  sink.write('hello ');
  sink.write('world');
  sink.write('!');
  sink.close();
  const result = await sink.result;
  return result;
}
