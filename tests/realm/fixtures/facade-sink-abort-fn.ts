/** Fixture: aborts a Facade sink with a typed error. */
import { writeChunks } from 'fino:test-facade';

export default async function (): Promise<unknown> {
  const sink = writeChunks('my-stream');
  sink.abort(new Error('sink input aborted'));
  return await sink.result;
}
