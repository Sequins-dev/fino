/**
 * Fixture: pool worker that accepts calls but never resolves them.
 * Used to test termination of a Realm call that never settles.
 */
export default function never(): Promise<never> {
  return new Promise<never>(() => {});
}
