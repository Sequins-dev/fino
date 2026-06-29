/**
* Benchmarks for fino:format/csv
*
* Run with: cargo run -- --bench benchmarks/csv.bench.mjs
*/
import { parse, stringify, parseStream } from 'fino:format/csv';
import { bench } from 'fino:bench';
function makeRows(n: number, cols: number): string[][] {
  const header = Array.from({ length: cols }, (_, i) => `col${i}`);
  const rows = [header];
  for (let i = 0; i < n; i++) {
    rows.push(Array.from({ length: cols }, (_, j) => `value-${i}-${j}`));
  }
  return rows;
}
const SMALL_CSV = stringify(makeRows(10, 5));
const MEDIUM_CSV = stringify(makeRows(1e3, 10));
const LARGE_CSV = stringify(makeRows(1e4, 10));
const QUOTED_CSV = stringify(makeRows(1e3, 5).map((r) => r.map((v) => `${v}, extra`)));
const UNICODE_CSV = (() => {
  const rows = [['lang', 'greeting']];
  const pairs = [
    ['日本語', 'こんにちは'],
    ['Ελληνικά', 'Γεια σας'],
    ['中文', '你好'],
    ['한국어', '안녕하세요']
  ];
  for (let i = 0; i < 250; i++) rows.push(pairs[i % pairs.length]!);
  return stringify(rows);
})();
const enc = new TextEncoder();
const LARGE_BYTES = enc.encode(LARGE_CSV);
bench('parse by size', (b) => {
  b.measure('10 rows × 5 cols', () => parse(SMALL_CSV));
  b.measure('1K rows × 10 cols', () => parse(MEDIUM_CSV));
  b.measure('10K rows × 10 cols', () => parse(LARGE_CSV));
  b.measure('10K rows — bytes', () => parse(LARGE_BYTES));
  b.measure('1K quoted rows', () => parse(QUOTED_CSV));
  b.measure('unicode content', () => parse(UNICODE_CSV));
});
bench('parse with header', (b) => {
  b.measure('1K rows as records', () => parse(MEDIUM_CSV, { header: true }));
  b.measure('10K rows as records', () => parse(LARGE_CSV, { header: true }));
});
bench('stringify', (b) => {
  const small = parse(SMALL_CSV) as string[][];
  const medium = parse(MEDIUM_CSV) as string[][];
  const large = parse(LARGE_CSV) as string[][];
  b.measure('10 rows', () => stringify(small));
  b.measure('1K rows', () => stringify(medium));
  b.measure('10K rows', () => stringify(large));
});
async function asStream(csv: string): Promise<AsyncIterable<Uint8Array>> {
  const bytes = enc.encode(csv);
  const chunkSize = 4096;
  return (async function* () {
    for (let off = 0; off < bytes.length; off += chunkSize) {
      yield bytes.subarray(off, off + chunkSize);
    }
  })();
}
bench('parseStream', (b) => {
  b.measure('1K rows × 4KB chunks', async () => {
    const src = await asStream(MEDIUM_CSV);
    for await (const _ of parseStream(src)) {}
  });
  b.measure('10K rows × 4KB chunks', async () => {
    const src = await asStream(LARGE_CSV);
    for await (const _ of parseStream(src)) {}
  });
});
