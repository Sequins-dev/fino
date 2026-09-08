/** Force queued children before a single reactor can begin their initialization. */
import * as native from 'internal:scheduler-native';
import { readable, removeRead } from 'internal:runtime/loop';
import { Realm } from 'fino:realm';

for (let round = 0; round < 8; round++) {
  // This fixture runs with one worker. The parent owns that worker until the
  // await below, so forcing the child is ordered before its initialization.
  const child = native.createScheduledRealm(
    '',
    'internal:test-worker',
    [],
    false,
    undefined,
    undefined,
    false,
  );
  native.registerReactorWake(child.owner, child.wakeFd);
  native.forceScheduledRealm(child.handle);
  await readable(child.completionFd);
  removeRead(child.completionFd);
  const status = native.takeScheduledRealmStatus(child.handle);
  const acceptsSignals = native.signalReactorOwner(child.owner);
  native.closeScheduledRealm(child.handle);
  if (status.kind !== 'done') throw new Error(`forced initialization returned ${status.kind}`);
  if (acceptsSignals)
    throw new Error('failed initialization left an active owner after completion');
}
const survivor = Realm.fromSource("export default () => 'alive';");
if ((await survivor.call()) !== 'alive') throw new Error('pool did not recover');
console.log('retired-initializations=8');
