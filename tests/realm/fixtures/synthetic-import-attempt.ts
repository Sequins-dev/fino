/**
* Realm fixture: attempts to dynamic-import 'testIsolation' (installed only
* in the parent realm) and returns true if it throws, false if it succeeds.
*/
export default async function attempt(): Promise<boolean> {
  try {
    await import('testIsolation');
    return false;
  } catch {
    return true;
  }
}
