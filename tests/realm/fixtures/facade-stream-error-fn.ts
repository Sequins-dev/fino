/**
* Fixture: exercises error propagation from a streaming facade.
*
* The parent's `failingChunks` streaming handler yields one item then throws.
* This realm must see that error as a rejected iteration.
*/
import { failingChunks } from 'fino:test-facade';
export default async function(): Promise<unknown> {
  const collected: unknown[] = [];
  try {
    for await (const item of failingChunks()) {
      collected.push(item);
    }
    return {
      ok: true,
      collected
    };
  } catch (err) {
    return {
      ok: false,
      message: (err as Error).message,
      collected
    };
  }
}
