import { chunks, greet } from 'fino:test-facade';

export default async function (): Promise<void> {
  await greet('world');
  for await (const _chunk of chunks()) {
    // Drain the stream so its request completes.
  }
}
