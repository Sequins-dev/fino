/**
 * Realm fixture — default-exports a function that throws.
 * Used by call() error propagation tests.
 */
export default function alwaysThrows(_input: unknown): never {
  throw new Error('deliberate error from child realm');
}
