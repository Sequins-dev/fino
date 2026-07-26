/**
 * Pool worker: returns after a configurable delay.
 * Used to test load-based dispatch.
 */
export default async function slow(delayMs: number, tag: string): Promise<string> {
  await new Promise<void>((res) => setTimeout(res, delayMs));
  return tag;
}
