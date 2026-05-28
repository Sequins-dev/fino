/**
 * Fixture: exercises a streaming facade export.
 *
 * The parent registers a Facade for 'fino:test-facade' with a `chunks` streaming
 * export that yields multiple values.  This realm collects them into an array
 * and returns it as the call result.
 */
import { chunks } from 'fino:test-facade';

export default async function (): Promise<unknown[]> {
  const results: unknown[] = [];
  for await (const item of chunks()) {
    results.push(item);
  }
  return results;
}
