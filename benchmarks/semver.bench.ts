/**
 * Benchmarks for fino:semver
 *
 * Run with: cargo run -- bench benchmarks/semver.bench.ts
 */
import { compare, maxSatisfying, parse, satisfies } from 'fino:semver';
import { bench } from 'fino:bench';
bench('semver', (b) => {
  b.measure('parse', () => parse('1.2.3-beta.1+build.5'));
  b.measure('compare', () => compare('1.2.3', '1.3.0'));
  b.measure('satisfies', () => satisfies('1.2.3', '^1.0.0'));
  b.measure('maxSatisfying', () => maxSatisfying(['1.0.0', '1.2.3', '2.0.0'], '^1.0.0'));
});
