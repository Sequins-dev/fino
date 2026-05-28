/**
 * Fixture: calls an unknown method on a facade — expects rejection.
 */
import { unknownMethod } from 'fino:test-facade';

export default async function (): Promise<unknown> {
  return unknownMethod();
}
