/**
 * Fixture: calls a facade-provided virtual module.
 *
 * The parent registers a Facade for 'test:facade' that handles 'greet'.
 * This realm imports it and calls it; the result is returned via default export.
 */
import { greet } from 'test:facade';

export default async function (): Promise<unknown> {
  return greet('world');
}
