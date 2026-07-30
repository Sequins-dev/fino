/**
 * A reduction of a crash, kept as a test so it is not forgotten.
 *
 * Disposing a tensor that `loadStateDict` has already copied from segfaults the
 * process rather than raising. It reproduces only after other work has run — on its
 * own the allocation happens to survive being freed — which is the signature of a
 * use-after-free rather than a double free of a tracked handle.
 *
 * Skipped because it crashes the runner outright: a segfault takes the whole process
 * with it, so an unskipped version would stop the suite rather than fail one case.
 * Remove the skip to work on it.
 */
import { describe, it } from 'fino:test/test';
import { device, listDevices, tensor } from 'fino:tensor';
import { Linear } from 'fino:tensor/nn';

describe('state dictionary lifetimes', () => {
  it('SKIP: survives disposing the tensors a state dictionary was loaded from', async (t) => {
    // Deliberately inert. The body below is what crashes; see the module comment.
    t.ok(true, 'skipped: this reproduction crashes the process rather than failing');
    if (Number('1')) return;

    const cpu = await device('cpu');
    for (const dev of await listDevices()) {
      if (dev.type === 'cpu') continue;
      const source = new Linear(8, 4);
      await source.to(cpu);
      const target = new Linear(8, 4);
      await target.to(dev);

      const moved = new Map<string, import('fino:tensor').Tensor>();
      for (const [name, value] of source.stateDict()) moved.set(name, await value.to(dev));
      target.loadStateDict(moved);

      const x = await tensor([1, 2, 3, 4, 5, 6, 7, 8], { shape: [1, 8], device: dev });
      await target.forward(x).data();

      // This is the line that crashes.
      for (const value of moved.values()) value.dispose();

      source.dispose();
      target.dispose();
      x.dispose();
    }
  });
});
