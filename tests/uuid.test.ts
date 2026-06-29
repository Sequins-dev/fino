import { describe, it } from 'fino:test/test';
import { UUID, v4, v7, parse, validate, version, NIL, MAX } from 'fino:uuid';
describe('fino:uuid — v4', () => {
  it('generates a valid v4', (t) => {
    const id = v4();
    t.ok(id instanceof UUID);
    t.equal(validate(id.toString()), true);
    t.equal(version(id.toString()), 4);
  });
  it('v4 has correct version and variant bits', (t) => {
    const id = v4();
    t.equal(id.version, 4);
    t.equal(id.variant, 1);
  });
  it('v4 generates distinct UUIDs', (t) => {
    const a = v4(), b = v4();
    t.ok(a.toString() !== b.toString());
  });
  it('v4 timestamp is null', (t) => {
    t.equal(v4().timestamp, null);
  });
  it('UUID.v4() and v4() are equivalent', (t) => {
    t.ok(UUID.v4() instanceof UUID);
  });
});
describe('fino:uuid — v7', () => {
  it('generates a valid v7', (t) => {
    const id = v7();
    t.ok(id instanceof UUID);
    t.equal(validate(id.toString()), true);
    t.equal(version(id.toString()), 7);
  });
  it('v7 has correct version and variant bits', (t) => {
    const id = v7();
    t.equal(id.version, 7);
    t.equal(id.variant, 1);
  });
  it('v7 lexicographic order matches chronological order', (t) => {
    const uuids: UUID[] = [];
    for (let i = 0; i < 20; i++) uuids.push(v7());
    for (let i = 1; i < uuids.length; i++) {
      t.ok(uuids[i - 1]!.toString() <= uuids[i]!.toString(), `${uuids[i - 1]} <= ${uuids[i]}`);
    }
  });
  it('v7 extracts a timestamp close to Date.now()', (t) => {
    const before = Date.now();
    const id = v7();
    const after = Date.now();
    const ts = id.timestamp;
    t.ok(ts instanceof Date);
    t.ok(ts!.getTime() >= before, `timestamp ${ts!.getTime()} >= before ${before}`);
    t.ok(ts!.getTime() <= after, `timestamp ${ts!.getTime()} <= after ${after}`);
  });
  it('v7 IDs within same millisecond are monotonically increasing', (t) => {
    // Flood with many calls to force same-ms counter increments
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) ids.push(v7().toString());
    for (let i = 1; i < ids.length; i++) {
      t.ok(ids[i - 1]! <= ids[i]!, `ids[${i - 1}] <= ids[${i}]`);
    }
  });
  it('v7 remains monotonic when same-millisecond counter rolls over', (t) => {
    const originalNow = Date.now;
    Date.now = () => 2e12;
    try {
      const ids: string[] = [];
      for (let i = 0; i < 4098; i++) ids.push(v7().toString());
      for (let i = 1; i < ids.length; i++) {
        t.ok(ids[i - 1]! < ids[i]!, `ids[${i - 1}] < ids[${i}]`);
      }
    } finally {
      Date.now = originalNow;
    }
  });
});
describe('fino:uuid — parse and validate', () => {
  it('parse roundtrips', (t) => {
    const s = v4().toString();
    t.equal(parse(s).toString(), s);
  });
  it('parse throws on invalid input', (t) => {
    t.throws(() => parse('not-a-uuid'), /invalid uuid/i);
    t.throws(() => parse(''), /invalid uuid/i);
    t.throws(() => parse('00000000-0000-0000-0000-00000000000g'), /invalid uuid/i);
  });
  it('validate returns true for valid UUIDs', (t) => {
    t.equal(validate(v4().toString()), true);
    t.equal(validate(v7().toString()), true);
    t.equal(validate('00000000-0000-0000-0000-000000000000'), true);
  });
  it('validate returns false for invalid input', (t) => {
    t.equal(validate('not-a-uuid'), false);
    t.equal(validate(''), false);
    t.equal(validate('550e8400-e29b-41d4-a716'), false);
  });
  it('version() extracts version number', (t) => {
    t.equal(version(v4().toString()), 4);
    t.equal(version(v7().toString()), 7);
  });
});
describe('fino:uuid — UUID.from', () => {
  it('passes UUID through', (t) => {
    const id = v4();
    t.ok(UUID.from(id) === id);
  });
  it('parses string', (t) => {
    const s = v4().toString();
    t.equal(UUID.from(s).toString(), s);
  });
  it('wraps Uint8Array', (t) => {
    const id = v4();
    const bytes = id.toBytes();
    t.equal(UUID.from(bytes).toString(), id.toString());
  });
  it('throws on wrong-length Uint8Array', (t) => {
    t.throws(() => UUID.from(new Uint8Array(10)), /16 bytes/);
  });
});
describe('fino:uuid — constants', () => {
  it('NIL is all-zero string', (t) => {
    t.equal(NIL, '00000000-0000-0000-0000-000000000000');
  });
  it('MAX is all-f string', (t) => {
    t.equal(MAX, 'ffffffff-ffff-ffff-ffff-ffffffffffff');
  });
  it('UUID.NIL.version is 0', (t) => {
    t.equal(UUID.NIL.version, 0);
  });
});
describe('fino:uuid — toBytes and equals', () => {
  it('toBytes returns 16-byte Uint8Array', (t) => {
    const b = v4().toBytes();
    t.ok(b instanceof Uint8Array);
    t.equal(b.byteLength, 16);
  });
  it('toBytes is a copy', (t) => {
    const id = v4();
    const b = id.toBytes();
    b[0] = 255;
    t.ok(id.toBytes()[0] !== 255);
  });
  it('equals returns true for identical UUIDs', (t) => {
    const s = v4().toString();
    t.ok(parse(s).equals(parse(s)));
  });
  it('equals returns false for different UUIDs', (t) => {
    t.ok(!v4().equals(v4()));
  });
});
describe('fino:uuid — serialization', () => {
  it('toJSON returns string', (t) => {
    const id = v4();
    t.equal(id.toJSON(), id.toString());
  });
  it('[Symbol.toPrimitive] coerces to string', (t) => {
    const id = v4();
    t.equal(`${id}`, id.toString());
  });
  it('JSON.stringify embeds as string', (t) => {
    const id = v4();
    t.equal(JSON.stringify({ id }), `{"id":"${id.toString()}"}`);
  });
});
describe('crypto.randomUUID integration', () => {
  it('crypto.randomUUID() returns a valid v4 string', (t) => {
    const s = crypto.randomUUID();
    t.equal(typeof s, 'string');
    t.equal(validate(s), true);
    t.equal(version(s), 4);
  });
});
