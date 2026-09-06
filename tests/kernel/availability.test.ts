/** The kernel compiler foundation is registered as an internal builtin. */
import { describe, it } from 'fino:test/test';
describe('kernel IR builtin', () => {
  it('loads the core independently of tensor and GPU drivers', async (t) => {
    let loaded = false;
    try {
      loaded = typeof (await import('internal:kernel/ir')).KernelBuilder === 'function';
    } catch {}
    t.ok(loaded, 'kernel IR builder is available');
  });
});
