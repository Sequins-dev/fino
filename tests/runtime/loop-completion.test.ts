import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
import { timeout } from 'internal:runtime/loop';

describe('Realm completion checkpoints', () => {
  for (const startCheck of [1, 2]) {
    it(`finishes promise-only cleanup started by completion check ${startCheck}`, async (t) => {
      const realm = Realm.fromSource(`
        // Defer this import until the bootstrap module finishes evaluating.
        const { driveLoop } = await import('internal:bootstrap');
        let checks = 0;
        let done = false;
        driveLoop(() => {
          if (++checks === ${startCheck}) {
            void (async () => {
              await Promise.resolve();
              await Promise.resolve();
              done = true;
            })();
          }
          return done;
        }, () => {}, () => true);
      `);
      const running = realm.run();
      const deadline = timeout(5000);
      try {
        t.equal(
          await Promise.race([running.then(() => true), deadline.then(() => false)]),
          true,
          'completed cleanup needs no unrelated wake',
        );
      } finally {
        deadline.cancel();
        realm.terminate({ force: true });
        await running.catch(() => {});
      }
    });
  }

  it('parks while cleanup waits for an external event', async (t) => {
    const realm = Realm.fromSource(`
      import { port } from 'fino:realm/self';
      const { driveLoop } = await import('internal:bootstrap');
      let release;
      const released = new Promise((resolve) => { release = resolve; });
      port.addEventListener('message', () => release());
      port.start();
      let checks = 0;
      let done = false;
      driveLoop(() => {
        if (++checks === 2) {
          void (async () => {
            port.postMessage('cleanup-started');
            await released;
            done = true;
          })();
        }
        if (checks > 10 && !done) throw new Error('idle completion check is spinning');
        return done;
      }, () => {}, () => true);
    `);
    let started!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => (started = resolve));
    realm.port.addEventListener('message', () => started());
    realm.port.start();
    let settled = false;
    const running = realm.run().then(() => {
      settled = true;
    });
    const deadline = timeout(5000);
    try {
      const ready = await Promise.race([
        cleanupStarted.then(() => true),
        running.then(() => false),
        deadline.then(() => false),
      ]);
      t.equal(ready, true, 'cleanup reaches its external wait');
      await timeout(10);
      t.equal(settled, false, 'cleanup has not been abandoned');
      realm.port.postMessage('release');
      t.equal(
        await Promise.race([running.then(() => true), deadline.then(() => false)]),
        true,
        'the external event resumes cleanup and completes the Realm',
      );
    } finally {
      deadline.cancel();
      realm.terminate({ force: true });
      await running.catch(() => {});
    }
  });
});
