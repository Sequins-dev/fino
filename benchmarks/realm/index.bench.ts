/**
 * Benchmarks for fino:realm
 *
 * Run with: cargo run -- bench benchmarks/realm/index.bench.ts
 */
import {
  DiskFsConfig,
  Facade,
  FacadeHandle,
  ImportMap,
  SystemDnsConfig,
  SystemNetConfig,
} from 'fino:realm';
import { bench } from 'fino:bench';
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
bench('realm facades and providers', (b) => {
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
  b.measure('provider configs', () => {
    new DiskFsConfig({ root: '/tmp' });
    new SystemNetConfig();
    new SystemDnsConfig();
  });
});
