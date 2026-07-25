/**
* Exercises registered SQLite VFS cleanup while reactor isolates are retired.
*/
import { Database } from 'fino:database/sqlite';
import { Realm } from 'fino:realm';
import type openWithoutClosing from '../realm/fixtures/sqlite-unclosed.ts';
const entry = new URL('../realm/fixtures/sqlite-unclosed.ts', import.meta.url).pathname;
for (let i = 0; i < 64; i++) {
  const realm = new Realm<typeof openWithoutClosing>({ entry });
  await realm.call();
  realm.terminate();
  await realm.run();
  const pressure = Array.from({ length: 2e4 }, (_, j) => ({
    i,
    j,
    value: `project-${i}-${j}`
  }));
  if (pressure.length !== 2e4) throw new Error('allocation failed');
}
await using db = await Database.open(':memory:');
