/**
 * Realm fixture — default-exports an async function.
 * Used by call() tests.
 */
export default async function asyncDouble(input: number): Promise<number> {
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
  return input * 2;
}
