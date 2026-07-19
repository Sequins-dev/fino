import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';

describe('nested Realm allocation', () => {
  it('allocates through the owner private control port', async (t) => {
    using realm = new Realm<(value: unknown) => Promise<unknown>>({
      entry: new URL('./fixtures/nested-call.ts', import.meta.url).pathname
    });
    t.equal(await realm.call('nested'), 'nested');
  });

  it('keeps concurrent requester channels isolated', async (t) => {
    const entry = new URL('./fixtures/nested-instance.ts', import.meta.url).pathname;
    using first = new Realm<() => Promise<string>>({ entry });
    using second = new Realm<() => Promise<string>>({ entry });
    const ids = await Promise.all([first.call(), second.call()]);
    t.notEqual(ids[0], ids[1]);
  });
});
