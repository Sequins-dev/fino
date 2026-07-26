/**
 * Tests for internal:format/thrift — binary, compact, and JSON protocol codecs.
 */
import { describe, it } from 'fino:test/test';
import {
  BinaryProtocol,
  CompactProtocol,
  JSONProtocol,
  TType,
  TMessageType,
  ThriftError,
  skip,
  readStruct,
  writeStruct,
  type Protocol,
  type ThriftValue,
} from 'internal:format/thrift';
type ProtoCtor = {
  new (input?: Uint8Array): Protocol;
};
const PROTOCOLS: [string, ProtoCtor][] = [
  ['binary', BinaryProtocol],
  ['compact', CompactProtocol],
  ['json', JSONProtocol],
];
// Write a single-field struct then read the value back.
function roundTripField(
  Ctor: ProtoCtor,
  type: number,
  write: (p: Protocol) => void,
  read: (p: Protocol) => unknown,
): unknown {
  const w = new Ctor();
  w.writeStructBegin();
  w.writeFieldBegin('', type, 1);
  write(w);
  w.writeFieldEnd();
  w.writeFieldStop();
  w.writeStructEnd();
  const r = new Ctor(w.bytes());
  r.readStructBegin();
  const field = r.readFieldBegin();
  if (field.id !== 1 || field.type !== type)
    throw new Error(`bad field header ${field.id}/${field.type}`);
  const value = read(r);
  r.readFieldEnd();
  const stop = r.readFieldBegin();
  if (stop.type !== TType.STOP) throw new Error('expected STOP');
  r.readStructEnd();
  return value;
}
describe('thrift scalar round-trips', () => {
  for (const [name, Ctor] of PROTOCOLS) {
    it(`${name}: bool`, (t) => {
      t.equal(
        roundTripField(
          Ctor,
          TType.BOOL,
          (p) => p.writeBool(true),
          (p) => p.readBool(),
        ),
        true,
        'true',
      );
      t.equal(
        roundTripField(
          Ctor,
          TType.BOOL,
          (p) => p.writeBool(false),
          (p) => p.readBool(),
        ),
        false,
        'false',
      );
    });
    it(`${name}: byte`, (t) => {
      t.equal(
        roundTripField(
          Ctor,
          TType.BYTE,
          (p) => p.writeByte(-12),
          (p) => p.readByte(),
        ),
        -12,
        'i8',
      );
    });
    it(`${name}: i16`, (t) => {
      t.equal(
        roundTripField(
          Ctor,
          TType.I16,
          (p) => p.writeI16(-1234),
          (p) => p.readI16(),
        ),
        -1234,
        'i16',
      );
    });
    it(`${name}: i32`, (t) => {
      t.equal(
        roundTripField(
          Ctor,
          TType.I32,
          (p) => p.writeI32(-123456789),
          (p) => p.readI32(),
        ),
        -123456789,
        'i32',
      );
    });
    it(`${name}: i64 beyond 2^53`, (t) => {
      const v = 9007199254740993n;
      t.equal(
        roundTripField(
          Ctor,
          TType.I64,
          (p) => p.writeI64(v),
          (p) => p.readI64(),
        ),
        v,
        'i64 exact',
      );
      t.equal(
        roundTripField(
          Ctor,
          TType.I64,
          (p) => p.writeI64(-v),
          (p) => p.readI64(),
        ),
        -v,
        'negative i64',
      );
    });
    it(`${name}: double`, (t) => {
      t.equal(
        roundTripField(
          Ctor,
          TType.DOUBLE,
          (p) => p.writeDouble(3.14159),
          (p) => p.readDouble(),
        ),
        3.14159,
        'double',
      );
      t.equal(
        roundTripField(
          Ctor,
          TType.DOUBLE,
          (p) => p.writeDouble(-.5),
          (p) => p.readDouble(),
        ),
        -.5,
        'negative',
      );
      t.ok(
        Number.isNaN(
          roundTripField(
            Ctor,
            TType.DOUBLE,
            (p) => p.writeDouble(NaN),
            (p) => p.readDouble(),
          ) as number,
        ),
        'NaN',
      );
      t.equal(
        roundTripField(
          Ctor,
          TType.DOUBLE,
          (p) => p.writeDouble(Infinity),
          (p) => p.readDouble(),
        ),
        Infinity,
        'Infinity',
      );
      t.equal(
        roundTripField(
          Ctor,
          TType.DOUBLE,
          (p) => p.writeDouble(-Infinity),
          (p) => p.readDouble(),
        ),
        -Infinity,
        '-Infinity',
      );
    });
    it(`${name}: string (utf-8)`, (t) => {
      t.equal(
        roundTripField(
          Ctor,
          TType.STRING,
          (p) => p.writeString('grüße 日本'),
          (p) => p.readString(),
        ),
        'grüße 日本',
        'unicode',
      );
      t.equal(
        roundTripField(
          Ctor,
          TType.STRING,
          (p) => p.writeString(''),
          (p) => p.readString(),
        ),
        '',
        'empty',
      );
    });
    it(`${name}: binary`, (t) => {
      const bytes = new Uint8Array([0, 1, 2, 255, 128]);
      const out = roundTripField(
        Ctor,
        TType.STRING,
        (p) => p.writeBinary(bytes),
        (p) => p.readBinary(),
      ) as Uint8Array;
      t.deepEqual(Array.from(out), Array.from(bytes), 'binary bytes');
    });
  }
});
describe('thrift container round-trips', () => {
  for (const [name, Ctor] of PROTOCOLS) {
    it(`${name}: list<i32>`, (t) => {
      const w = new Ctor();
      w.writeListBegin(TType.I32, 3);
      for (const v of [10, 20, 30]) w.writeI32(v);
      w.writeListEnd();
      const r = new Ctor(w.bytes());
      const h = r.readListBegin();
      const out: number[] = [];
      for (let i = 0; i < h.size; i++) out.push(r.readI32());
      r.readListEnd();
      t.deepEqual(out, [10, 20, 30], 'list values');
    });
    it(`${name}: set<bool>`, (t) => {
      const w = new Ctor();
      w.writeSetBegin(TType.BOOL, 3);
      for (const v of [true, false, true]) w.writeBool(v);
      w.writeSetEnd();
      const r = new Ctor(w.bytes());
      const h = r.readSetBegin();
      const out: boolean[] = [];
      for (let i = 0; i < h.size; i++) out.push(r.readBool());
      r.readSetEnd();
      t.deepEqual(out, [true, false, true], 'set bools (compact bool-in-collection)');
    });
    it(`${name}: map<string,i64>`, (t) => {
      const w = new Ctor();
      w.writeMapBegin(TType.STRING, TType.I64, 2);
      w.writeString('a');
      w.writeI64(1n);
      w.writeString('b');
      w.writeI64(2n);
      w.writeMapEnd();
      const r = new Ctor(w.bytes());
      const h = r.readMapBegin();
      const out = new Map<string, bigint>();
      for (let i = 0; i < h.size; i++) out.set(r.readString(), r.readI64());
      r.readMapEnd();
      t.equal(out.get('a'), 1n, 'a');
      t.equal(out.get('b'), 2n, 'b');
    });
    it(`${name}: empty map and list`, (t) => {
      const w = new Ctor();
      w.writeMapBegin(TType.STRING, TType.I32, 0);
      w.writeMapEnd();
      w.writeListBegin(TType.I32, 0);
      w.writeListEnd();
      const r = new Ctor(w.bytes());
      t.equal(r.readMapBegin().size, 0, 'empty map');
      r.readMapEnd();
      t.equal(r.readListBegin().size, 0, 'empty list');
      r.readListEnd();
    });
  }
});
describe('thrift struct + field id deltas + generic value model', () => {
  for (const [name, Ctor] of PROTOCOLS) {
    it(`${name}: multi-field struct, monotonic + gapped + non-monotonic ids`, (t) => {
      // ids 1, 2, 20 (delta > 15 forces the compact varint escape), then 5 (backwards)
      const fields = new Map<number, ThriftValue>([
        [
          1,
          {
            type: TType.I32,
            value: 100,
          },
        ],
        [
          2,
          {
            type: TType.BOOL,
            value: true,
          },
        ],
        [
          20,
          {
            type: TType.STRING,
            value: 'hi',
          },
        ],
        [
          5,
          {
            type: TType.I64,
            value: 42n,
          },
        ],
      ]);
      const w = new Ctor();
      writeStruct(w, fields);
      const back = readStruct(new Ctor(w.bytes()));
      t.deepEqual(
        back.get(1),
        {
          type: TType.I32,
          value: 100,
        },
        'field 1',
      );
      t.deepEqual(
        back.get(2),
        {
          type: TType.BOOL,
          value: true,
        },
        'field 2 (bool in header for compact)',
      );
      t.deepEqual(
        back.get(20),
        {
          type: TType.STRING,
          value: 'hi',
        },
        'field 20 (delta escape)',
      );
      t.deepEqual(
        back.get(5),
        {
          type: TType.I64,
          value: 42n,
        },
        'field 5 (non-monotonic)',
      );
    });
    it(`${name}: nested struct + list of structs`, (t) => {
      const inner: ThriftValue = {
        type: TType.STRUCT,
        fields: new Map([
          [
            1,
            {
              type: TType.I32,
              value: 7,
            },
          ],
        ]),
      };
      const fields = new Map<number, ThriftValue>([
        [1, inner],
        [
          2,
          {
            type: TType.LIST,
            elemType: TType.STRUCT,
            values: [inner, inner],
          },
        ],
      ]);
      const w = new Ctor();
      writeStruct(w, fields);
      const back = readStruct(new Ctor(w.bytes()));
      t.deepEqual(back.get(1), inner, 'nested struct');
      t.deepEqual(
        back.get(2),
        {
          type: TType.LIST,
          elemType: TType.STRUCT,
          values: [inner, inner],
        },
        'list of structs',
      );
    });
  }
});
describe('thrift message envelopes', () => {
  for (const [name, Ctor] of PROTOCOLS) {
    it(`${name}: message begin/end`, (t) => {
      const w = new Ctor();
      w.writeMessageBegin('ping', TMessageType.CALL, 7);
      w.writeStructBegin();
      w.writeFieldStop();
      w.writeStructEnd();
      w.writeMessageEnd();
      const r = new Ctor(w.bytes());
      const h = r.readMessageBegin();
      t.equal(h.name, 'ping', 'name');
      t.equal(h.type, TMessageType.CALL, 'type');
      t.equal(h.seqid, 7, 'seqid');
      r.readStructBegin();
      r.readFieldBegin();
      r.readStructEnd();
      r.readMessageEnd();
    });
  }
});
describe('thrift skip', () => {
  for (const [name, Ctor] of PROTOCOLS) {
    it(`${name}: skips unknown fields of every type`, (t) => {
      const w = new Ctor();
      w.writeStructBegin();
      w.writeFieldBegin('', TType.I32, 1);
      w.writeI32(1);
      w.writeFieldEnd();
      w.writeFieldBegin('', TType.LIST, 2);
      w.writeListBegin(TType.STRING, 2);
      w.writeString('x');
      w.writeString('y');
      w.writeListEnd();
      w.writeFieldEnd();
      w.writeFieldBegin('', TType.MAP, 3);
      w.writeMapBegin(TType.I32, TType.I32, 1);
      w.writeI32(9);
      w.writeI32(8);
      w.writeMapEnd();
      w.writeFieldEnd();
      w.writeFieldBegin('', TType.STRUCT, 4);
      w.writeStructBegin();
      w.writeFieldBegin('', TType.BOOL, 1);
      w.writeBool(true);
      w.writeFieldEnd();
      w.writeFieldStop();
      w.writeStructEnd();
      w.writeFieldEnd();
      w.writeFieldBegin('', TType.I32, 5);
      w.writeI32(999);
      w.writeFieldEnd();
      w.writeFieldStop();
      w.writeStructEnd();
      const r = new Ctor(w.bytes());
      r.readStructBegin();
      let last = 0;
      for (;;) {
        const f = r.readFieldBegin();
        if (f.type === TType.STOP) break;
        if (f.id === 5) {
          t.equal(r.readI32(), 999, 'reached field 5 after skipping 2/3/4');
        } else {
          skip(r, f.type);
        }
        r.readFieldEnd();
        last = f.id;
      }
      r.readStructEnd();
      t.equal(last, 5, 'iterated to the final field');
    });
  }
});
describe('thrift compact known byte vectors', () => {
  it('zig-zag + field header + bool-in-header', (t) => {
    const w = new CompactProtocol();
    w.writeStructBegin();
    w.writeFieldBegin('', TType.I32, 1);
    w.writeI32(1);
    w.writeFieldEnd();
    w.writeFieldBegin('', TType.BOOL, 2);
    w.writeBool(true);
    w.writeFieldEnd();
    w.writeFieldStop();
    w.writeStructEnd();
    t.deepEqual(Array.from(w.bytes()), [21, 2, 17, 0], 'exact compact bytes');
  });
  it('empty map is a single zero byte', (t) => {
    const w = new CompactProtocol();
    w.writeMapBegin(TType.I32, TType.I32, 0);
    w.writeMapEnd();
    t.deepEqual(Array.from(w.bytes()), [0], 'empty map header');
  });
  it('short list packs size into the high nibble', (t) => {
    const w = new CompactProtocol();
    w.writeListBegin(TType.I32, 3);
    w.writeListEnd();
    t.deepEqual(Array.from(w.bytes()), [53], 'short list header');
  });
  it('message envelope starts 0x82 + version/type byte', (t) => {
    const w = new CompactProtocol();
    w.writeMessageBegin('x', TMessageType.CALL, 0);
    const bytes = Array.from(w.bytes());
    t.equal(bytes[0], 130, 'protocol id');
    t.equal(bytes[1] & 31, 1, 'version 1');
    t.equal((bytes[1]! >> 5) & 7, TMessageType.CALL, 'message type');
  });
});
describe('thrift binary strict + legacy', () => {
  it('writes strict and reads it back', (t) => {
    const w = new BinaryProtocol();
    w.writeMessageBegin('do', TMessageType.REPLY, 3);
    w.writeMessageEnd();
    const bytes = w.bytes();
    t.equal(bytes[0]! & 128, 128, 'strict high bit set');
    const h = new BinaryProtocol(bytes).readMessageBegin();
    t.equal(h.name, 'do', 'name');
    t.equal(h.type, TMessageType.REPLY, 'type');
    t.equal(h.seqid, 3, 'seqid');
  });
  it('reads a hand-crafted legacy (non-strict) message', (t) => {
    // name length (i32 BE) + name + type byte + seqid (i32 BE)
    const name = 'go';
    const buf = new Uint8Array(4 + name.length + 1 + 4);
    const dv = new DataView(buf.buffer);
    dv.setInt32(0, name.length, false);
    for (let i = 0; i < name.length; i++) buf[4 + i] = name.charCodeAt(i);
    buf[4 + name.length] = TMessageType.CALL;
    dv.setInt32(4 + name.length + 1, 11, false);
    const h = new BinaryProtocol(buf).readMessageBegin();
    t.equal(h.name, 'go', 'legacy name');
    t.equal(h.type, TMessageType.CALL, 'legacy type');
    t.equal(h.seqid, 11, 'legacy seqid');
  });
});
describe('thrift cross-protocol independence + errors', () => {
  it('compact and binary produce different bytes for the same struct', (t) => {
    const build = (Ctor: ProtoCtor) => {
      const w = new Ctor();
      writeStruct(
        w,
        new Map([
          [
            1,
            {
              type: TType.I32,
              value: 300,
            },
          ],
        ]),
      );
      return Array.from(w.bytes());
    };
    t.notEqual(
      JSON.stringify(build(BinaryProtocol)),
      JSON.stringify(build(CompactProtocol)),
      'distinct encodings',
    );
  });
  it('truncated compact input throws ThriftError', (t) => {
    t.throws(
      () => {
        const r = new CompactProtocol(new Uint8Array([21]));
        r.readStructBegin();
        r.readFieldBegin();
        r.readI32();
      },
      ThriftError,
      'truncation',
    );
  });
  it('bad compact protocol id throws ThriftError', (t) => {
    t.throws(
      () => new CompactProtocol(new Uint8Array([0, 33, 0])).readMessageBegin(),
      ThriftError,
      'bad protocol id',
    );
  });
  it('truncated binary string length throws ThriftError', (t) => {
    t.throws(
      () => {
        const r = new BinaryProtocol(new Uint8Array([0, 0, 0, 10, 1, 2]));
        r.readString();
      },
      ThriftError,
      'binary truncation',
    );
  });
});
