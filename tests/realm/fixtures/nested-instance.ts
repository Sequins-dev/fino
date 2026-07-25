import { Realm } from 'fino:realm';

export default async function nestedInstance(): Promise<string> {
  using child = new Realm<(delayMs: number) => Promise<string>>({
    entry: new URL('./scaling-fn.ts', import.meta.url).pathname
  });
  return await child.call(0);
}
