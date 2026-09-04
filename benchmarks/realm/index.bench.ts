/**
 * Benchmarks for fino:realm
 *
 * Run with: cargo run -- bench benchmarks/realm/index.bench.ts
 */
import { Facade, FacadeHandle, ImportMap, Realm } from 'fino:realm';
import { bench } from 'fino:bench';
import { cwd } from 'fino:process';
const echoEntry = `file://${cwd()}/tests/realm/fixtures/echo-fn.ts`;
bench('realm import rules', (b) => {
  b.measure('ImportMap.inherit', () =>
    ImportMap.inherit([
      {
        pattern: 'fino:context',
        directive: 'inherit',
      },
      {
        pattern: 'fino:ffi',
        directive: 'block',
      },
    ]),
  );
  b.measure('ImportMap.deny', () =>
    ImportMap.deny([
      {
        pattern: 'fino:context',
        directive: 'inherit',
      },
    ]),
  );
});
bench('realm facades', (b) => {
  b.measure('Facade registration', () => {
    new Facade('bench:facade', ['sum'])
      .handle('sum', async (a, b) => Number(a) + Number(b))
      .stream('chunks', async function* chunks() {
        yield 'chunk';
      })
      .sendStream('write', async (_args, source) => {
        let count = 0;
        for await (const _ of source) count++;
        return count;
      });
  });
  b.measure('FacadeHandle', () => new FacadeHandle({ close: () => undefined }));
});
bench('realm scheduler', (b) => {
  b.measure('construct and call 16 realms concurrently', async () => {
    const realms = Array.from(
      { length: 16 },
      () =>
        new Realm<(value: number) => number>({
          entry: echoEntry,
        }),
    );
    await Promise.all(realms.map((realm, index) => realm.call(index)));
  });
});
