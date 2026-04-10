/**
 * Pool worker: returns the current correlation ID so the test can verify
 * that it was propagated from the parent via fino:realm/pool.
 */
import { correlationIdContext } from 'fino:realm/pool';

export default function getCorrelationId(): string | undefined {
  return correlationIdContext.get();
}
