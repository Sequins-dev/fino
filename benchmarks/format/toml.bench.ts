/**
 * Benchmarks for fino:format/toml
 *
 * Run with: cargo run -- --bench benchmarks/toml.bench.mjs
 */
import { parse, stringify } from 'fino:format/toml';
import { bench } from 'fino:bench';
const SMALL_TOML = `
title = "Example"
count = 42
pi = 3.14159
enabled = true
tags = ["a", "b", "c"]
`;
const TABLE_TOML = (() => {
  const lines = [
    '[server]',
    'host = "localhost"',
    'port = 8080',
    '[database]',
    'name = "mydb"',
    'pool = 10',
  ];
  return lines.join('\n');
})();
const MEDIUM_TOML = (() => {
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) {
    lines.push(`[[items]]`);
    lines.push(`id = ${i}`);
    lines.push(`name = "item-${i}"`);
    lines.push(`value = ${(i * 1.5).toFixed(3)}`);
    lines.push(`tags = ["t${i % 5}", "t${(i + 1) % 5}"]`);
  }
  return lines.join('\n');
})();
const LARGE_TOML = (() => {
  const lines: string[] = [];
  for (let i = 0; i < 1e3; i++) {
    lines.push(`key_${i} = "value_${i}"`);
  }
  return lines.join('\n');
})();
const UNICODE_TOML = (() => {
  const pairs = [
    ['ja', '日本語テキスト'],
    ['zh', '中文内容'],
    ['el', 'Ελληνικά'],
  ];
  return pairs.map(([k, v]) => `${k} = "${v}"`).join('\n');
})();
const enc = new TextEncoder();
bench('parse by size', (b) => {
  b.measure('small scalars', () => parse(SMALL_TOML));
  b.measure('table sections', () => parse(TABLE_TOML));
  b.measure('100 array tables', () => parse(MEDIUM_TOML));
  b.measure('1K flat keys', () => parse(LARGE_TOML));
  b.measure('unicode values', () => parse(UNICODE_TOML));
  b.measure('bytes input', () => parse(enc.encode(MEDIUM_TOML)));
});
bench('stringify', (b) => {
  const small = parse(SMALL_TOML);
  const medium = parse(MEDIUM_TOML);
  const large = parse(LARGE_TOML);
  b.measure('small doc', () => stringify(small));
  b.measure('100 array tables', () => stringify(medium));
  b.measure('1K flat keys', () => stringify(large));
});
bench('round-trip', (b) => {
  const medium = parse(MEDIUM_TOML);
  b.measure('parse → stringify → parse', () => parse(stringify(medium)));
});
