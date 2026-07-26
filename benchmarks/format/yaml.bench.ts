/**
 * Benchmarks for fino:format/yaml
 *
 * Run with: cargo run -- --bench benchmarks/yaml.bench.mjs
 */
import { parse, stringify, parseAll } from 'fino:format/yaml';
import { bench } from 'fino:bench';
const SMALL_YAML = `
name: Alice
age: 30
active: true
score: 99.5
tags:
  - admin
  - user
`;
const MAPPING_YAML = (() => {
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) {
    lines.push(`key_${i}: value_${i}`);
  }
  return lines.join('\n');
})();
const SEQ_OF_MAPS_YAML = (() => {
  const items: string[] = [];
  for (let i = 0; i < 100; i++) {
    items.push(`- id: ${i}\n  name: item-${i}\n  value: ${(i * 1.5).toFixed(3)}`);
  }
  return items.join('\n');
})();
const NESTED_YAML = `
server:
  host: localhost
  port: 8080
  tls:
    cert: /etc/ssl/cert.pem
    key: /etc/ssl/key.pem
database:
  primary:
    host: db1.example.com
    port: 5432
    name: mydb
  replica:
    host: db2.example.com
    port: 5432
    name: mydb
`;
const BLOCK_SCALAR_YAML = (() => {
  const items: string[] = [];
  for (let i = 0; i < 50; i++) {
    items.push(`item_${i}: |\n  line one of item ${i}\n  line two of item ${i}\n  line three`);
  }
  return items.join('\n');
})();
const UNICODE_YAML = `
ja: 日本語テキスト
zh: 中文内容
el: Ελληνικά κείμενα
ar: نص عربي
ko: 한국어 텍스트
`;
const MULTI_DOC_YAML = Array.from({ length: 10 }, (_, i) => `id: ${i}\nname: doc-${i}`).join(
  '\n---\n',
);
const enc = new TextEncoder();
bench('parse by size', (b) => {
  b.measure('small mapping', () => parse(SMALL_YAML));
  b.measure('100-key mapping', () => parse(MAPPING_YAML));
  b.measure('100 seq-of-maps', () => parse(SEQ_OF_MAPS_YAML));
  b.measure('nested config', () => parse(NESTED_YAML));
  b.measure('block scalars ×50', () => parse(BLOCK_SCALAR_YAML));
  b.measure('unicode content', () => parse(UNICODE_YAML));
  b.measure('bytes input', () => parse(enc.encode(SEQ_OF_MAPS_YAML)));
});
bench('parseAll (multi-doc)', (b) => {
  b.measure('10 documents', () => parseAll(MULTI_DOC_YAML));
});
bench('stringify', (b) => {
  const small = parse(SMALL_YAML);
  const mapping = parse(MAPPING_YAML);
  const seqMaps = parse(SEQ_OF_MAPS_YAML);
  b.measure('small mapping', () => stringify(small as any));
  b.measure('100-key mapping', () => stringify(mapping as any));
  b.measure('100 seq-of-maps', () => stringify(seqMaps as any));
});
bench('round-trip', (b) => {
  const seqMaps = parse(SEQ_OF_MAPS_YAML);
  b.measure('parse → stringify → parse', () => parse(stringify(seqMaps as any)));
});
