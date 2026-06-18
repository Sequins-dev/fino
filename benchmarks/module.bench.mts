/**
 * Benchmarks for fino:module
 *
 * Run with: cargo run -- bench benchmarks/module.bench.mts
 */

import { SyntheticModule } from 'fino:module';
import { bench } from 'fino:bench';

bench('SyntheticModule', (b) => {
  b.measure('construct', () => new SyntheticModule('bench-module', { value: 42 }));
  b.measure('install/import/uninstall', async () => {
    const specifier = `bench-module-${nextId++}`;
    const module = new SyntheticModule(specifier, { value: 42 });
    module.install();
    try {
      const ns = await import(specifier);
      if (ns.value !== 42) throw new Error('synthetic module import returned unexpected value');
    } finally {
      module.uninstall();
    }
  });
});

let nextId = 0;
