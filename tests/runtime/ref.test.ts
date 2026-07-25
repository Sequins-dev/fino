/** Tests for fino:runtime ref/unref liveness controls. */
import { describe, it } from 'fino:test/test';
import { hasRef, ref, unref } from 'fino:runtime';
import * as loop from 'internal:runtime/loop';

describe('runtime handle references', () => {
  it('unrefs and rerefs numeric web timers without changing timer IDs', (t) => {
    const before = loop._activeHandleCounts().timers;
    const timer = setTimeout(() => {}, 10_000);
    try {
      t.equal(typeof timer, 'number', 'web timer remains a numeric ID');
      t.equal(hasRef(timer), true);
      t.equal(loop._activeHandleCounts().timers, before + 1, 'referenced timer counts toward liveness');
      t.equal(unref(timer), timer, 'unref returns the supplied handle');
      t.equal(hasRef(timer), false);
      t.equal(loop._activeHandleCounts().timers, before, 'unreferenced timer no longer counts toward liveness');
      ref(timer);
      t.equal(hasRef(timer), true);
      t.equal(loop._activeHandleCounts().timers, before + 1, 'reref restores liveness');
    } finally {
      clearTimeout(timer);
    }
  });

  it('still delivers an unreferenced timer while other referenced work is alive', async (t) => {
    let fired = false;
    const timer = setTimeout(() => { fired = true; }, 1);
    unref(timer);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    t.equal(fired, true);
  });

  it('delegates to refable resource objects', (t) => {
    let referenced = true;
    const resource = {
      ref() { referenced = true; return this; },
      unref() { referenced = false; return this; },
      hasRef() { return referenced; }
    };
    t.equal(unref(resource), resource);
    t.equal(hasRef(resource), false);
    t.equal(ref(resource), resource);
    t.equal(hasRef(resource), true);
  });

  it('rejects unknown and non-refable handles', (t) => {
    t.throws(() => unref(999_999_999), /unknown timer/i);
    t.throws(() => ref({}), /refable runtime handle/i);
  });
});
