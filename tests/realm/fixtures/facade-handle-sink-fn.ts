import { openHandle } from 'fino:test-facade';

export default async function (): Promise<unknown> {
  const handle = await openHandle();
  const sink = handle.writeChunks('log');
  sink.write('one');
  sink.write('two');
  sink.close();
  return sink.result;
}
