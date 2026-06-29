/**
* Benchmarks for fino:format/xml
*
* Run with: cargo run -- --bench benchmarks/xml.bench.mjs
*/
import { parse, stringify, parseStream } from 'fino:format/xml';
import { bench } from 'fino:bench';
function makeItemList(n: number): string {
  const items = Array.from({ length: n }, (_, i) => `  <item id="${i}" category="cat${i % 5}"><name>Item ${i}</name><value>${(i * 1.5).toFixed(2)}</value></item>`);
  return `<items>${items.join('')}</items>`;
}
const SMALL_XML = makeItemList(10);
const MEDIUM_XML = makeItemList(500);
const LARGE_XML = makeItemList(5e3);
const NAMESPACE_XML = `<ns:root xmlns:ns="http://example.com" xmlns:x="http://other.example.com">
  <ns:child x:attr="value">text content</ns:child>
  <ns:child x:attr="other">more text</ns:child>
</ns:root>`;
const CDATA_XML = `<root>${Array.from({ length: 100 }, (_, i) => `<item><![CDATA[<not>xml</not> content ${i}]]></item>`).join('')}</root>`;
const UNICODE_XML = `<root>${[
  '<item lang="ja">日本語テキスト</item>',
  '<item lang="zh">中文内容</item>',
  '<item lang="el">Ελληνικά κείμενα</item>',
  '<item lang="ar">نص عربي</item>'
].repeat(50).join('')}</root>`;
const enc = new TextEncoder();
const LARGE_BYTES = enc.encode(LARGE_XML);
bench('parse by size', (b) => {
  b.measure('10 items', () => parse(SMALL_XML));
  b.measure('500 items', () => parse(MEDIUM_XML));
  b.measure('5K items', () => parse(LARGE_XML));
  b.measure('5K items bytes', () => parse(LARGE_BYTES));
  b.measure('namespaces', () => parse(NAMESPACE_XML));
  b.measure('CDATA blocks', () => parse(CDATA_XML));
  b.measure('unicode', () => parse(UNICODE_XML));
});
bench('parse options', (b) => {
  b.measure('namespaces:false', () => parse(MEDIUM_XML, { namespaces: false }));
  b.measure('namespaces:true', () => parse(MEDIUM_XML, { namespaces: true }));
});
bench('stringify', (b) => {
  const small = parse(SMALL_XML);
  const medium = parse(MEDIUM_XML);
  const large = parse(LARGE_XML);
  b.measure('10 items', () => stringify(small, { xmlDeclaration: false }));
  b.measure('500 items', () => stringify(medium, { xmlDeclaration: false }));
  b.measure('5K items', () => stringify(large, { xmlDeclaration: false }));
});
async function xmlStream(xml: string, chunkSize = 4096): Promise<AsyncIterable<Uint8Array>> {
  const bytes = enc.encode(xml);
  return (async function* () {
    for (let off = 0; off < bytes.length; off += chunkSize) {
      yield bytes.subarray(off, off + chunkSize);
    }
  })();
}
bench('parseStream', (b) => {
  b.measure('500 items × 4KB chunks', async () => {
    const src = await xmlStream(MEDIUM_XML);
    for await (const _ of parseStream(src)) {}
  });
  b.measure('5K items × 4KB chunks', async () => {
    const src = await xmlStream(LARGE_XML);
    for await (const _ of parseStream(src)) {}
  });
});
