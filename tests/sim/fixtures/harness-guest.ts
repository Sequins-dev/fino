// @ts-expect-error `app:kv` is supplied as a simulation Facade.
import { get, set } from 'app:kv';

export default async function (key: string, value: unknown): Promise<unknown> {
  await set(key, value);
  return get(key);
}
