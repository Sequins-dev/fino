import { Realm } from 'fino:realm';

export default async function nestedCall(value: unknown): Promise<unknown> {
  using child = new Realm({ entry: new URL('./echo-fn.ts', import.meta.url).pathname });
  return await child.call(value);
}
