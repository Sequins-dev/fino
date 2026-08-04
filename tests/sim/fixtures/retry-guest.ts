/** A guest that retries a flaky dependency a bounded number of times. */
import { fetchRecord } from 'app:api';
export default async function main(): Promise<{ attempts: number; value: unknown }> {
  let attempts = 0;
  let lastError: unknown;
  for (let i = 0; i < 3; i++) {
    attempts++;
    try {
      return { attempts, value: await fetchRecord('r-1') };
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** i));
    }
  }
  throw lastError;
}
