/** Both compiler targets consume the same driver-free kernel fixtures. */
import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { fixtures } from './fixtures.ts';
import { env, os, run, withFile } from './tools.ts';
const fs = new DiskFileSystem();
let metal = false;
if (os === 'darwin') {
  try {
    metal = (await run('/usr/bin/xcrun', ['-sdk', 'macosx', 'metal', '--version'])).code === 0;
  } catch {}
}
describe('kernel Metal lowering', () => {
  it('loads the standalone Metal lowering', async (t) => {
    let loaded = false;
    try {
      loaded = typeof (await import('internal:kernel/msl')).lowerToMSL === 'function';
    } catch {}
    t.ok(loaded, 'Metal lowering is available');
  });
  it('emits deterministic source without mutating the shared IR', async (t) => {
    const { lowerToMSL } = await import('internal:kernel/msl');
    const { lowerToSPIRV } = await import('internal:kernel/spirv');
    for (const ir of fixtures()) {
      const before = structuredClone(ir);
      const source = lowerToMSL(ir);
      t.ok(source.includes(`kernel void ${ir.name}`));
      t.equal(source, lowerToMSL(ir));
      lowerToSPIRV(ir);
      t.deepEqual(ir, before);
    }
  });
  it('has the required Metal compiler', (t) => {
    t.ok(metal || env.FINO_REQUIRE_METAL !== '1', 'install the Metal toolchain when required');
  });
  for (const ir of fixtures()) {
    it(
      `compiles ${ir.name}`,
      { skip: metal ? false : 'Metal compiler is not available' },
      async (t) => {
        const { lowerToMSL } = await import('internal:kernel/msl');
        await withFile('metal', new TextEncoder().encode(lowerToMSL(ir)), async (path) => {
          const output = path + '.air';
          try {
            const result = await run('/usr/bin/xcrun', [
              '-sdk',
              'macosx',
              'metal',
              '-std=metal3.0',
              '-c',
              path,
              '-o',
              output,
            ]);
            t.equal(result.code, 0, result.output || 'Metal compiler accepts the shared kernel');
          } finally {
            try {
              await fs.unlink(output);
            } catch {}
          }
        });
      },
    );
  }
});
