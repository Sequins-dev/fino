/**
 * Drive forced Realm termination in an isolated reactor pool.
 *
 * A nested Realm cannot schedule its own controller while a synchronous child
 * exhausts the surrounding test runner's pool. After the controller issues the
 * interrupt, this fixture proves the pool accepts new work.
 */
import { Realm } from 'fino:realm';

const runaway = new Realm<() => number>({
  entry: new URL('./runaway.ts', import.meta.url).pathname,
});
const call = runaway.call();
await new Promise((resolve) => setTimeout(resolve, 150));
runaway.terminate({ force: true });

let rejected = false;
try {
  await call;
} catch (error) {
  if (!(error instanceof Error) || !/exited before returning/i.test(error.message)) throw error;
  rejected = true;
}
if (!rejected) throw new Error('forced runaway call unexpectedly resolved');

// Closing the parent port removes the cooperative control path. Forced
// termination must still wake a Realm parked on an unrelated timer.
const parked = Realm.fromSource(`
  import { port } from 'fino:realm/self';
  setTimeout(() => {}, 10_000);
  port.postMessage('ready');
`);
await new Promise<void>((resolve) => {
  parked.port.addEventListener('message', () => resolve(), { once: true });
  parked.port.start();
});
await new Promise((resolve) => setTimeout(resolve, 50));
parked.port.close();
parked.terminate({ force: true });
let deadline: ReturnType<typeof setTimeout>;
const stopped = await Promise.race([
  parked.run().then(() => true),
  new Promise<false>((resolve) => {
    deadline = setTimeout(() => resolve(false), 2_000);
  }),
]);
clearTimeout(deadline!);
await parked.run();
if (!stopped) throw new Error('forced termination did not wake a Realm with a closed parent port');

const after = new Realm<(value: string) => string>({
  entry: new URL('./echo-fn.ts', import.meta.url).pathname,
});
if ((await after.call('still working')) !== 'still working') {
  throw new Error('reactor pool did not recover after forced termination');
}
console.log('force-terminated=1');
