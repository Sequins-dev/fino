import { Realm } from 'fino:realm';

export default async function readNestedEffects(entry: string) {
  const realm = new Realm({ entry });
  try {
    return await realm.call();
  } finally {
    realm.terminate();
    await realm.run();
  }
}
