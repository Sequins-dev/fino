/**
 * An unregistered builtin specifier must fail loudly.
 *
 * V8's module-resolve contract is that an empty result carries a pending
 * exception. The loader's BUILTINS lookup used `?`, returning None without
 * throwing, so instantiation failed silently: the import promise never
 * settled and the process exited 0 having run nothing.
 *
 * That made the test runner itself untrustworthy. A test file importing a
 * specifier that was renamed or never registered simply vanished from the
 * suite — and took the rest of the run with it, still reporting success. A
 * suite that can silently skip files cannot vouch for anything else in it.
 */
import { describe, it } from 'fino:test/test';

describe('builtin module resolution', () => {
  it('rejects an unregistered fino: specifier by name', async (t) => {
    await t.rejects(
      () => import('fino:no-such-module-exists'),
      /Cannot resolve builtin module 'fino:no-such-module-exists'/,
      'the error names the specifier that could not be resolved',
    );
  });

  it('rejects an unregistered internal: specifier by name', async (t) => {
    await t.rejects(
      () => import('internal:no-such-module-exists'),
      /Cannot resolve builtin module 'internal:no-such-module-exists'/,
      'internal specifiers report the same way',
    );
  });

  it('still resolves a registered builtin', async (t) => {
    const mod = await import('fino:process');
    t.ok(typeof mod.cwd === 'function', 'a real builtin still loads');
  });
});
