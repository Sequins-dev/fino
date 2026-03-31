/**
 * Benchmarks for surge:process
 *
 * Run with: cargo run -- --bench benchmarks/process.bench.mjs
 */

import { pid, ppid, argv, env, execPath, cwd, exit, os, arch } from 'surge:process';
import { bench } from 'surge:bench';

bench('static properties', (b) => {
  b.measure('pid',      () => pid);
  b.measure('ppid',     () => ppid);
  b.measure('execPath', () => execPath);
  b.measure('os',       () => os);
  b.measure('arch',     () => arch);
});

bench('argv', (b) => {
  b.measure('argv (array access)',    () => argv);
  b.measure('argv[0]',               () => argv[0]);
  b.measure('argv.length',           () => argv.length);
});

bench('env', (b) => {
  b.group('property access', (g) => {
    g.measure('env.HOME',     () => env.HOME);
    g.measure('env.PATH',     () => env.PATH);
    g.measure('env.USER',     () => env.USER);
    g.measure('env.MISSING',  () => env.SURGE_BENCH_NONEXISTENT_VAR);
  });

  b.group('Object operations', (g) => {
    g.measure('Object.keys(env)',    () => Object.keys(env));
    g.measure('Object.entries(env)', () => Object.entries(env));
  });
});

bench('cwd()', (b) => {
  b.measure('cwd()', () => cwd());
});
