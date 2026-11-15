import { describe, it } from 'fino:test/test';

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

import * as stream from 'fino:stream';

describe('text stream transforms', () => {
  it('exposes composable decoding and line framing', (t) => {
    t.equal(typeof stream.decodeText, 'function');
    t.equal(typeof stream.splitLines, 'function');
    t.equal(typeof stream.readLines, 'function');
  });

  it('decodes UTF-8 and frames universal lines at every byte split', async (t) => {
    const encoded = new TextEncoder().encode('\ufeffa€😀\r\nb\rc\n\nlast');
    for (let split = 0; split <= encoded.length; split++) {
      t.deepEqual(
        await collect(
          stream.readLines([encoded.subarray(0, split), encoded.subarray(split)], {
            terminators: 'universal',
          }),
        ),
        ['a€😀', 'b', 'c', '', 'last'],
      );
    }
  });

  it('composes decoding separately and preserves visible byte spans', async (t) => {
    const slab = new Uint8Array([0, 97, 10, 98, 0]);
    const text = stream.decodeText([new DataView(slab.buffer, 1, 3)]);
    t.deepEqual(await collect(stream.splitLines(text)), ['a', 'b']);
  });

  it('flushes incomplete UTF-8 in replacement mode and rejects it in fatal mode', async (t) => {
    const tail = [new Uint8Array([0xe2, 0x82])];
    t.deepEqual(await collect(stream.decodeText(tail)), ['�']);
    await t.rejects(() => collect(stream.decodeText(tail, { fatal: true })), TypeError);
    t.deepEqual(await collect(stream.decodeText([new Uint8Array([0xff])])), ['�']);
  });

  it('preserves BOM on request and propagates source failures', async (t) => {
    t.deepEqual(
      await collect(stream.decodeText([new TextEncoder().encode('\ufeffx')], { ignoreBOM: true })),
      ['\ufeffx'],
    );
    const failure = new Error('source failed');
    async function* source() {
      yield new Uint8Array([97]);
      throw failure;
    }
    await t.rejects(() => collect(stream.readLines(source())), /source failed/);
    await t.rejects(() => collect(stream.splitLines([1] as any)), TypeError);
    await t.rejects(() => collect(stream.splitLines([], { terminators: 'bad' as any })), TypeError);
    await t.rejects(() => collect(stream.splitLines([], { finalLine: 'bad' as any })), TypeError);
    t.deepEqual(await collect(stream.splitLines(['\r', '\n'], { maxLineLength: 0 })), ['']);
  });

  it('keeps LF framing, CR stripping, blank lines and final-line policy explicit', async (t) => {
    t.deepEqual(await collect(stream.splitLines(['a\r', '\nb\rc\n\nlast'])), [
      'a',
      'b\rc',
      '',
      'last',
    ]);
    t.deepEqual(await collect(stream.splitLines(['a\nlast'], { finalLine: 'discard' })), ['a']);
    t.deepEqual(await collect(stream.splitLines([])), []);
    t.deepEqual(await collect(stream.splitLines(['\n'])), ['']);
    t.deepEqual(await collect(stream.splitLines(['a\r'])), ['a\r']);
  });

  it('enforces line bounds across chunks and closes the source on overflow', async (t) => {
    let closed = 0;
    async function* source() {
      try {
        yield 'ab';
        yield 'cd';
      } finally {
        closed++;
      }
    }
    await t.rejects(() => collect(stream.splitLines(source(), { maxLineLength: 3 })), RangeError);
    t.equal(closed, 1);
    t.deepEqual(await collect(stream.splitLines(['abc\r', '\n'], { maxLineLength: 3 })), ['abc']);
    await t.rejects(() => collect(stream.splitLines(['abc\r'], { maxLineLength: 3 })), RangeError);
    await t.rejects(() => collect(stream.splitLines([], { maxLineLength: -1 })), RangeError);
  });

  it('closes decoding and source iterators when the consumer stops early', async (t) => {
    let closed = 0;
    let pulls = 0;
    async function* source() {
      try {
        pulls++;
        yield new TextEncoder().encode('a\nb\n');
        pulls++;
        yield new Uint8Array();
      } finally {
        closed++;
      }
    }
    const iterator = stream.readLines(source());
    t.equal((await iterator.next()).value, 'a');
    await iterator.return(undefined);
    t.equal(closed, 1);
    t.equal(pulls, 1, 'no unnecessary read ahead');
  });
});
