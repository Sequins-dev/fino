/**
* Opens a SQLite database and deliberately leaves it for Realm shutdown.
*/
import { Database } from 'fino:database/sqlite';
export default async function openWithoutClosing(): Promise<void> {
  await Database.open(':memory:');
}
