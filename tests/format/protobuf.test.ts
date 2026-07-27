/**
 * Protocol Buffers wire-format compatibility and schema codec tests.
 */
import { describe, it } from 'fino:test/test';
import { defineMessage, ProtobufError, type MessageCodec } from 'fino:format/protobuf';

interface Test1 {
  a: number;
}

const Test1: MessageCodec<Test1> = defineMessage<Test1>({
  a: { number: 1, type: 'int32' },
});

interface Child {
  label: string;
}

const Child: MessageCodec<Child> = defineMessage<Child>({
  label: { number: 1, type: 'string' },
});

interface Sample {
  id: number;
  delta: number;
  enabled: boolean;
  total: bigint;
  ratio: number;
  name: string;
  payload: Uint8Array;
  scores: number[];
  aliases: string[];
  child?: Child;
}

const Sample: MessageCodec<Sample> = defineMessage<Sample>({
  id: { number: 1, type: 'uint32' },
  delta: { number: 2, type: 'sint32' },
  enabled: { number: 3, type: 'bool' },
  total: { number: 4, type: 'uint64' },
  ratio: { number: 5, type: 'double' },
  name: { number: 6, type: 'string' },
  payload: { number: 7, type: 'bytes' },
  scores: { number: 8, type: 'sint32', repeated: true },
  aliases: { number: 9, type: 'string', repeated: true },
  child: { number: 10, type: Child, optional: true },
});

describe('fino:format/protobuf compatibility', () => {
  it('matches the canonical protobuf int32 example', (t) => {
    t.deepEqual(Array.from(Test1.encode({ a: 150 })), [0x08, 0x96, 0x01]);
    t.deepEqual(Test1.decode(new Uint8Array([0x08, 0x96, 0x01])), { a: 150 });
  });

  it('matches protobuf length-delimited string encoding', (t) => {
    interface Test2 {
      b: string;
    }
    const Test2 = defineMessage<Test2>({
      b: { number: 2, type: 'string' },
    });
    t.deepEqual(
      Array.from(Test2.encode({ b: 'testing' })),
      [0x12, 0x07, 0x74, 0x65, 0x73, 0x74, 0x69, 0x6e, 0x67],
    );
  });

  it('round-trips scalar, packed, repeated, and nested fields', (t) => {
    const value: Sample = {
      id: 42,
      delta: -17,
      enabled: true,
      total: 9_007_199_254_740_993n,
      ratio: Math.PI,
      name: 'fino ✓',
      payload: new Uint8Array([0, 1, 2, 255]),
      scores: [-2, 0, 9],
      aliases: ['runtime', 'reactor'],
      child: { label: 'nested' },
    };
    t.deepEqual(Sample.decode(Sample.encode(value)), value);
  });

  it('omits default scalar values and restores protobuf defaults', (t) => {
    const encoded = Sample.encode({
      id: 0,
      delta: 0,
      enabled: false,
      total: 0n,
      ratio: 0,
      name: '',
      payload: new Uint8Array(),
      scores: [],
      aliases: [],
    });
    t.equal(encoded.byteLength, 0);
    t.deepEqual(Sample.decode(encoded), {
      id: 0,
      delta: 0,
      enabled: false,
      total: 0n,
      ratio: 0,
      name: '',
      payload: new Uint8Array(),
      scores: [],
      aliases: [],
    });
  });

  it('accepts packed and expanded encodings for repeated numeric fields', (t) => {
    // Field 8, expanded values -2, 0, 9 (ZigZag: 3, 0, 18).
    const expanded = new Uint8Array([0x40, 0x03, 0x40, 0x00, 0x40, 0x12]);
    t.deepEqual(Sample.decode(expanded).scores, [-2, 0, 9]);
    const packed = Sample.encode({
      id: 0,
      delta: 0,
      enabled: false,
      total: 0n,
      ratio: 0,
      name: '',
      payload: new Uint8Array(),
      scores: [-2, 0, 9],
      aliases: [],
    });
    t.deepEqual(Array.from(packed), [0x42, 0x03, 0x03, 0x00, 0x12]);
  });

  it('accepts packed input for a schema that emits expanded values', (t) => {
    interface Expanded {
      values: number[];
    }
    const Expanded = defineMessage<Expanded>({
      values: { number: 1, type: 'uint32', repeated: true, packed: false },
    });
    t.deepEqual(Expanded.decode(new Uint8Array([0x0a, 0x03, 0x01, 0x02, 0x03])), {
      values: [1, 2, 3],
    });
    t.deepEqual(
      Array.from(Expanded.encode({ values: [1, 2, 3] })),
      [0x08, 0x01, 0x08, 0x02, 0x08, 0x03],
    );
  });

  it('round-trips IEEE-754 non-finite floating-point values', (t) => {
    interface Floating {
      float: number;
      double: number;
    }
    const Floating = defineMessage<Floating>({
      float: { number: 1, type: 'float' },
      double: { number: 2, type: 'double' },
    });
    const decoded = Floating.decode(Floating.encode({ float: Infinity, double: NaN }));
    t.equal(decoded.float, Infinity);
    t.ok(Number.isNaN(decoded.double));
  });

  it('skips unknown fields and applies last-one-wins for scalar fields', (t) => {
    const bytes = new Uint8Array([0x08, 0x01, 0x98, 0x06, 0x07, 0x08, 0x02]);
    t.deepEqual(Test1.decode(bytes), { a: 2 });
  });
});

describe('fino:format/protobuf validation', () => {
  it('rejects invalid and reserved field numbers', (t) => {
    t.throws(() => defineMessage<Test1>({ a: { number: 0, type: 'int32' } }), ProtobufError);
    t.throws(() => defineMessage<Test1>({ a: { number: 19_000, type: 'int32' } }), ProtobufError);
  });

  it('rejects duplicate field numbers', (t) => {
    interface Duplicate {
      a: number;
      b: number;
    }
    t.throws(
      () =>
        defineMessage<Duplicate>({
          a: { number: 1, type: 'uint32' },
          b: { number: 1, type: 'uint32' },
        }),
      /duplicate/i,
    );
  });

  it('rejects truncated and invalid wire data', (t) => {
    t.throws(() => Sample.decode(new Uint8Array([0x32, 0x05, 0x61])), ProtobufError);
    t.throws(() => Sample.decode(new Uint8Array([0x0f])), ProtobufError);
  });
});
