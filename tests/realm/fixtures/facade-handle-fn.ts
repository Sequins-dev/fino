/**
 * Fixture: exercises a Facade that returns a FacadeHandle.
 *
 * The parent registers an `openHandle(key)` method that returns a handle with:
 *   - getValue()    — scalar: returns the stored value string
 *   - readChunks(n) — stream: yields n chunk strings
 *   - close()       — scalar: closes the handle (returns void)
 *
 * This fixture calls all three and returns a summary object.
 */
import { openHandle } from 'fino:test-facade';
export default async function (): Promise<{
  value: unknown;
  chunks: unknown[];
}> {
  const handle = await openHandle('my-key');
  const value = await handle.getValue();
  const chunks: unknown[] = [];
  for await (const chunk of handle.readChunks(3)) {
    chunks.push(chunk);
  }
  await handle.close();
  return {
    value,
    chunks,
  };
}
