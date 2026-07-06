/**
* Focused DNSSEC helper tests.
*/
import { describe, it } from 'fino:test/test';
import { _encodeName, RECORD_TYPES } from 'internal:net/dns-wire';
import { canonicalName, canonicalRrsetData, digestDnskey, dnskeyKeyTag, nsecCoversType, validateDnssecResponse, rrsigSignedData, validateSignedResponse, verifyRrsig } from '../../js/internal/net/dnssec.ts';
const cryptoAvailable = (globalThis as typeof globalThis & {
  cryptoAvailable?: boolean;
}).cryptoAvailable;
const skipCrypto = !cryptoAvailable && 'OpenSSL not available';
function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
function writeU16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function base64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function dnskeyFromRsaJwk(jwk: {
  n: string;
  e: string;
}): Uint8Array {
  const exponent = base64urlDecode(jwk.e);
  const modulus = base64urlDecode(jwk.n);
  const exponentLength = exponent.byteLength < 256 ? new Uint8Array([exponent.byteLength]) : concatBytes([new Uint8Array([0]), writeU16(exponent.byteLength)]);
  return concatBytes([
    writeU16(257),
    new Uint8Array([3, 8]),
    exponentLength,
    exponent,
    modulus
  ]);
}
function dnskeyFromEcJwk(jwk: {
  x: string;
  y: string;
}, algorithm = 13): Uint8Array {
  return concatBytes([
    writeU16(257),
    new Uint8Array([3, algorithm]),
    base64urlDecode(jwk.x),
    base64urlDecode(jwk.y)
  ]);
}
function dnskeyFromOkpJwk(jwk: {
  x: string;
}, algorithm = 15): Uint8Array {
  return concatBytes([
    writeU16(257),
    new Uint8Array([3, algorithm]),
    base64urlDecode(jwk.x)
  ]);
}
function derEcdsaToRaw(signature: Uint8Array, bytes: number): Uint8Array {
  let offset = 0;
  if (signature[offset++] !== 48) throw new Error('invalid ECDSA sequence');
  offset++;
  if (signature[offset++] !== 2) throw new Error('invalid ECDSA r marker');
  const rLength = signature[offset++]!;
  const r = signature.slice(offset, offset + rLength);
  offset += rLength;
  if (signature[offset++] !== 2) throw new Error('invalid ECDSA s marker');
  const sLength = signature[offset++]!;
  const s = signature.slice(offset, offset + sLength);
  const out = new Uint8Array(bytes * 2);
  out.set(r.slice(Math.max(0, r.byteLength - bytes)), bytes - Math.min(bytes, r.byteLength));
  out.set(s.slice(Math.max(0, s.byteLength - bytes)), bytes * 2 - Math.min(bytes, s.byteLength));
  return out;
}
function writeU32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}
function bitmapWindow(types: number[]): Uint8Array {
  const windows = new Map<number, number[]>();
  for (const type of types) {
    const window = type >> 8;
    const offset = type & 255;
    const arr = windows.get(window) ?? [];
    arr.push(offset);
    windows.set(window, arr);
  }
  const parts: Uint8Array[] = [];
  for (const [window, offsets] of [...windows.entries()].sort((a, b) => a[0] - b[0])) {
    const max = Math.max(...offsets);
    const bitmap = new Uint8Array(Math.floor(max / 8) + 1);
    for (const offset of offsets) bitmap[Math.floor(offset / 8)] |= 128 >> offset % 8;
    parts.push(new Uint8Array([window, bitmap.byteLength]), bitmap);
  }
  return concatBytes(parts);
}
const BASE32HEX = '0123456789ABCDEFGHIJKLMNOPQRSTUV';
function base32hexEncode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = buffer << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[buffer >> bits - 5 & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32HEX[buffer << 5 - bits & 31]!;
  return out;
}
async function nsec3Hash(name: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  let digest = new Uint8Array(await crypto.subtle.digest('SHA-1', concatBytes([_encodeName(name.toLowerCase()), salt])));
  for (let i = 0; i < iterations; i++) {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-1', concatBytes([digest, salt])));
  }
  return digest;
}
function nsec3Record(ownerHash: Uint8Array, zone: string, nextHash: Uint8Array, types: number[], options: {
  flags?: number;
  iterations?: number;
  salt?: Uint8Array;
} = {}) {
  const salt = options.salt ?? new Uint8Array(0);
  const iterations = options.iterations ?? 0;
  const flags = options.flags ?? 0;
  return {
    name: `${base32hexEncode(ownerHash)}.${zone}`,
    type: RECORD_TYPES.NSEC3,
    ttl: 300,
    rawData: concatBytes([
      new Uint8Array([1, flags]),
      writeU16(iterations),
      new Uint8Array([salt.byteLength]),
      salt,
      new Uint8Array([nextHash.byteLength]),
      nextHash,
      bitmapWindow(types)
    ]),
    data: {
      hashAlgorithm: 1,
      flags,
      iterations,
      salt,
      nextHashedOwnerName: nextHash,
      types
    }
  };
}
function nsecRecord(name: string, nextName: string, types: number[], ttl = 300) {
  return {
    name,
    type: RECORD_TYPES.NSEC,
    ttl,
    rawData: concatBytes([_encodeName(nextName), bitmapWindow(types)]),
    data: {
      nextDomainName: nextName,
      types
    }
  };
}
function aRecord(name: string, bytes = new Uint8Array([
  192,
  0,
  2,
  55
]), ttl = 300) {
  return {
    name,
    type: RECORD_TYPES.A,
    ttl,
    rawData: bytes,
    data: Array.from(bytes).join('.')
  };
}
function rrsigRecord(name: string, rrsig: {
  typeCovered: number;
  algorithm: number;
  labels: number;
  originalTtl: number;
  expiration: number;
  inception: number;
  keyTag: number;
  signerName: string;
  signature: Uint8Array;
}) {
  return {
    name,
    type: RECORD_TYPES.RRSIG,
    ttl: rrsig.originalTtl,
    rawData: concatBytes([
      writeU16(rrsig.typeCovered),
      new Uint8Array([rrsig.algorithm, rrsig.labels]),
      writeU32(rrsig.originalTtl),
      writeU32(rrsig.expiration),
      writeU32(rrsig.inception),
      writeU16(rrsig.keyTag),
      _encodeName(rrsig.signerName),
      rrsig.signature
    ]),
    data: rrsig
  };
}
async function signedRrsig(typeCovered: number, name: string, signerName: string, signerKeyTag: number, privateKey: CryptoKey, rrset: Array<{
  name: string;
  type: number;
  ttl: number;
  rawData: Uint8Array;
}>) {
  const rrsig = {
    typeCovered,
    algorithm: 8,
    labels: name === '.' ? 0 : name.split('.').filter(Boolean).length,
    originalTtl: 300,
    expiration: 4102444800,
    inception: 1,
    keyTag: signerKeyTag,
    signerName,
    signature: new Uint8Array()
  };
  rrsig.signature = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-V1_5' }, privateKey, rrsigSignedData(rrsig, rrset)));
  return rrsig;
}
describe('DNSSEC helpers', () => {
  it('canonicalName lowercases and preserves DNS wire label encoding', (t) => {
    t.deepEqual(Array.from(canonicalName('WwW.Example.COM.')), Array.from(_encodeName('www.example.com')), 'canonical name bytes are lower-case wire format');
  });
  it('dnskeyKeyTag matches RFC 4034 appendix B algorithm', (t) => {
    const dnskey = concatBytes([
      writeU16(257),
      new Uint8Array([3, 8]),
      new Uint8Array([
        1,
        0,
        1,
        3,
        1,
        0,
        1,
        9,
        8,
        7,
        6,
        5
      ])
    ]);
    let ac = 0;
    for (let i = 0; i < dnskey.byteLength; i++) {
      ac += (i & 1) === 0 ? dnskey[i]! << 8 : dnskey[i]!;
    }
    ac += ac >> 16 & 65535;
    const expected = ac & 65535;
    t.equal(dnskeyKeyTag(dnskey), expected, 'key tag is calculated from DNSKEY RDATA');
  });
  it('digestDnskey hashes canonical owner name plus DNSKEY RDATA', async (t) => {
    const dnskey = concatBytes([writeU16(257), new Uint8Array([
      3,
      8,
      1,
      0,
      1,
      3,
      1,
      0,
      1
    ])]);
    const digest = await digestDnskey('Example.COM.', dnskey, 2);
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', concatBytes([_encodeName('example.com'), dnskey])));
    t.equal(hex(digest), hex(expected), 'SHA-256 digest matches canonical DNSKEY digest input');
  });
  it('digestDnskey rejects unsupported DS digest types', async (t) => {
    const dnskey = concatBytes([writeU16(257), new Uint8Array([
      3,
      8,
      1,
      0,
      1,
      3,
      1,
      0,
      1
    ])]);
    await t.rejects(() => digestDnskey('example.com', dnskey, 3), (err) => err instanceof Error && /unsupported DS digest type 3/.test(err.message), 'unsupported DS digest type rejects');
  });
  it('canonicalRrsetData sorts records by canonical RDATA', (t) => {
    const rrset = [{
      name: 'Example.COM',
      type: RECORD_TYPES.A,
      ttl: 300,
      rawData: new Uint8Array([
        192,
        0,
        2,
        20
      ])
    }, {
      name: 'example.com.',
      type: RECORD_TYPES.A,
      ttl: 60,
      rawData: new Uint8Array([
        192,
        0,
        2,
        10
      ])
    }];
    const data = canonicalRrsetData(rrset, { originalTtl: 120 });
    const firstRdataOffset = _encodeName('example.com').byteLength + 10;
    t.deepEqual(Array.from(data.slice(firstRdataOffset, firstRdataOffset + 4)), [
      192,
      0,
      2,
      10
    ], 'lower RDATA sorts first');
    t.equal(new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(_encodeName('example.com').byteLength + 4, false), 120, 'original TTL is used');
  });
  it('nsecCoversType checks decoded type bitmaps', (t) => {
    t.equal(nsecCoversType([RECORD_TYPES.A, RECORD_TYPES.RRSIG], RECORD_TYPES.RRSIG), true, 'present type is covered');
    t.equal(nsecCoversType([RECORD_TYPES.A], RECORD_TYPES.AAAA), false, 'missing type is not covered');
  });
});
describe('DNSSEC signature validation', { skip: skipCrypto }, () => {
  it('verifyRrsig verifies a signed RSA/SHA-256 RRset', async (t) => {
    const keyPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as {
      n: string;
      e: string;
    };
    const dnskey = dnskeyFromRsaJwk(jwk);
    const keyTag = dnskeyKeyTag(dnskey);
    const rrset = [{
      name: 'www.test',
      type: RECORD_TYPES.A,
      ttl: 300,
      rawData: new Uint8Array([
        192,
        0,
        2,
        55
      ])
    }];
    const rrsig = {
      typeCovered: RECORD_TYPES.A,
      algorithm: 8,
      labels: 3,
      originalTtl: 300,
      expiration: 4102444800,
      inception: 1,
      keyTag,
      signerName: 'test',
      signature: new Uint8Array()
    };
    const signedData = rrsigSignedData(rrsig, rrset);
    rrsig.signature = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-V1_5' }, keyPair.privateKey, signedData));
    t.equal(await verifyRrsig(rrsig, rrset, {
      name: 'test',
      rawData: dnskey
    }, 2e3), true, 'signature verifies');
    const tampered = [{
      ...rrset[0]!,
      rawData: new Uint8Array([
        192,
        0,
        2,
        56
      ])
    }];
    t.equal(await verifyRrsig(rrsig, tampered, {
      name: 'test',
      rawData: dnskey
    }, 2e3), false, 'tampered RRset fails');
  });
  it('verifyRrsig verifies a DNSSEC raw ECDSAP256SHA256 signature', async (t) => {
    const keyPair = await crypto.subtle.generateKey({
      name: 'ECDSA',
      namedCurve: 'P-256',
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as {
      x: string;
      y: string;
    };
    const dnskey = dnskeyFromEcJwk(jwk, 13);
    const keyTag = dnskeyKeyTag(dnskey);
    const rrset = [aRecord('www.test')];
    const rrsig = {
      typeCovered: RECORD_TYPES.A,
      algorithm: 13,
      labels: 2,
      originalTtl: 300,
      expiration: 4102444800,
      inception: 1,
      keyTag,
      signerName: 'test',
      signature: new Uint8Array()
    };
    const derSignature = new Uint8Array(await crypto.subtle.sign({
      name: 'ECDSA',
      hash: 'SHA-256'
    }, keyPair.privateKey, rrsigSignedData(rrsig, rrset)));
    rrsig.signature = derSignature.byteLength === 64 ? derSignature : derEcdsaToRaw(derSignature, 32);
    t.equal(await verifyRrsig(rrsig, rrset, {
      name: 'test',
      rawData: dnskey
    }, 2e3), true, 'raw DNSSEC ECDSA signature verifies');
  });
  it('verifyRrsig verifies a DNSSEC Ed25519 signature', async (t) => {
    const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as {
      x: string;
    };
    const dnskey = dnskeyFromOkpJwk(jwk, 15);
    const keyTag = dnskeyKeyTag(dnskey);
    const rrset = [aRecord('www.test')];
    const rrsig = {
      typeCovered: RECORD_TYPES.A,
      algorithm: 15,
      labels: 2,
      originalTtl: 300,
      expiration: 4102444800,
      inception: 1,
      keyTag,
      signerName: 'test',
      signature: new Uint8Array()
    };
    rrsig.signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keyPair.privateKey, rrsigSignedData(rrsig, rrset)));
    t.equal(await verifyRrsig(rrsig, rrset, {
      name: 'test',
      rawData: dnskey
    }, 2e3), true, 'Ed25519 DNSSEC signature verifies');
    const tampered = [{
      ...rrset[0]!,
      rawData: new Uint8Array([
        192,
        0,
        2,
        99
      ])
    }];
    t.equal(await verifyRrsig(rrsig, tampered, {
      name: 'test',
      rawData: dnskey
    }, 2e3), false, 'tampered Ed25519 RRset fails');
  });
  it('validateSignedResponse accepts an answer covered only by Ed25519', async (t) => {
    const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const dnskey = dnskeyFromOkpJwk(await crypto.subtle.exportKey('jwk', keyPair.publicKey) as {
      x: string;
    });
    const keyTag = dnskeyKeyTag(dnskey);
    const answer = aRecord('www.test');
    const rrsig = {
      typeCovered: RECORD_TYPES.A,
      algorithm: 15,
      labels: 2,
      originalTtl: 300,
      expiration: 4102444800,
      inception: 1,
      keyTag,
      signerName: 'test',
      signature: new Uint8Array()
    };
    rrsig.signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keyPair.privateKey, rrsigSignedData(rrsig, [answer])));
    await validateSignedResponse({
      id: 1,
      flags: 33152,
      rcode: 0,
      truncated: false,
      answers: [answer, rrsigRecord('www.test', rrsig)],
      authorities: [],
      additionals: []
    }, 'www.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: 'test',
        rawData: dnskey
      }],
      now: 2e3
    });
  });
  it('validateSignedResponse accepts a trusted signed answer and rejects tampering', async (t) => {
    const keyPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as {
      n: string;
      e: string;
    };
    const dnskey = dnskeyFromRsaJwk(jwk);
    const keyTag = dnskeyKeyTag(dnskey);
    const answer = {
      name: 'www.test',
      type: RECORD_TYPES.A,
      ttl: 300,
      rawData: new Uint8Array([
        192,
        0,
        2,
        55
      ]),
      data: '192.0.2.55'
    };
    const rrsig = {
      typeCovered: RECORD_TYPES.A,
      algorithm: 8,
      labels: 3,
      originalTtl: 300,
      expiration: 4102444800,
      inception: 1,
      keyTag,
      signerName: 'test',
      signature: new Uint8Array()
    };
    rrsig.signature = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-V1_5' }, keyPair.privateKey, rrsigSignedData(rrsig, [answer])));
    const sigRecord = {
      name: 'www.test',
      type: RECORD_TYPES.RRSIG,
      ttl: 300,
      rawData: concatBytes([
        writeU16(RECORD_TYPES.A),
        new Uint8Array([8, 3]),
        writeU32(300),
        writeU32(rrsig.expiration),
        writeU32(rrsig.inception),
        writeU16(keyTag),
        _encodeName('test'),
        rrsig.signature
      ]),
      data: rrsig
    };
    const response = {
      id: 1,
      flags: 33152,
      rcode: 0,
      truncated: false,
      answers: [answer, sigRecord],
      authorities: [],
      additionals: []
    };
    const trustAnchors = [{
      name: 'test',
      rawData: dnskey
    }];
    await validateSignedResponse(response, 'www.test', RECORD_TYPES.A, {
      trustAnchors,
      now: 2e3
    });
    answer.rawData = new Uint8Array([
      192,
      0,
      2,
      56
    ]);
    await t.rejects(() => validateSignedResponse(response, 'www.test', RECORD_TYPES.A, {
      trustAnchors,
      now: 2e3
    }), (err) => (err as {
      code?: string;
    }).code === 'EDNSSEC', 'tampered response rejects with EDNSSEC');
  });
  it('validateDnssecResponse builds a DS/DNSKEY chain from a root trust anchor', async (t) => {
    const rootPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const childPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const rootDnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', rootPair.publicKey) as {
      n: string;
      e: string;
    });
    const childDnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', childPair.publicKey) as {
      n: string;
      e: string;
    });
    const rootKeyTag = dnskeyKeyTag(rootDnskey);
    const childKeyTag = dnskeyKeyTag(childDnskey);
    const childDsDigest = await digestDnskey('test', childDnskey, 2);
    const dsRecord = {
      name: 'test',
      type: RECORD_TYPES.DS,
      ttl: 300,
      rawData: concatBytes([
        writeU16(childKeyTag),
        new Uint8Array([8, 2]),
        childDsDigest
      ]),
      data: {
        keyTag: childKeyTag,
        algorithm: 8,
        digestType: 2,
        digest: childDsDigest
      }
    };
    const dsSig = await signedRrsig(RECORD_TYPES.DS, 'test', '.', rootKeyTag, rootPair.privateKey, [dsRecord]);
    const dnskeyRecord = {
      name: 'test',
      type: RECORD_TYPES.DNSKEY,
      ttl: 300,
      rawData: childDnskey,
      data: {
        flags: 257,
        protocol: 3,
        algorithm: 8,
        publicKey: childDnskey.slice(4)
      }
    };
    const dnskeySig = await signedRrsig(RECORD_TYPES.DNSKEY, 'test', 'test', childKeyTag, childPair.privateKey, [dnskeyRecord]);
    const answer = {
      name: 'www.test',
      type: RECORD_TYPES.A,
      ttl: 300,
      rawData: new Uint8Array([
        192,
        0,
        2,
        55
      ]),
      data: '192.0.2.55'
    };
    const answerSig = await signedRrsig(RECORD_TYPES.A, 'www.test', 'test', childKeyTag, childPair.privateKey, [answer]);
    const fetches = new Map<string, any>([[`test:${RECORD_TYPES.DS}`, {
      rcode: 0,
      answers: [dsRecord, rrsigRecord('test', dsSig)],
      authorities: []
    }], [`test:${RECORD_TYPES.DNSKEY}`, {
      rcode: 0,
      answers: [dnskeyRecord, rrsigRecord('test', dnskeySig)],
      authorities: []
    }]]);
    await validateDnssecResponse({
      rcode: 0,
      answers: [answer, rrsigRecord('www.test', answerSig)],
      authorities: []
    }, 'www.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: '.',
        rawData: rootDnskey
      }],
      now: 2e3,
      fetch: async (name, qtype) => {
        const response = fetches.get(`${name}:${qtype}`);
        if (!response) throw new Error(`unexpected fetch ${name}:${qtype}`);
        return response;
      }
    });
  });
  it('validateDnssecResponse bootstraps root DNSKEYs from a trust anchor before validating a child chain', async (t) => {
    const rootPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const childPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const rootDnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', rootPair.publicKey) as {
      n: string;
      e: string;
    });
    const childDnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', childPair.publicKey) as {
      n: string;
      e: string;
    });
    const rootKeyTag = dnskeyKeyTag(rootDnskey);
    const childKeyTag = dnskeyKeyTag(childDnskey);
    const childDsDigest = await digestDnskey('test', childDnskey, 2);
    const rootDnskeyRecord = {
      name: '.',
      type: RECORD_TYPES.DNSKEY,
      ttl: 300,
      rawData: rootDnskey,
      data: {
        flags: 257,
        protocol: 3,
        algorithm: 8,
        publicKey: rootDnskey.slice(4)
      }
    };
    const rootDnskeySig = await signedRrsig(RECORD_TYPES.DNSKEY, '.', '.', rootKeyTag, rootPair.privateKey, [rootDnskeyRecord]);
    const dsRecord = {
      name: 'test',
      type: RECORD_TYPES.DS,
      ttl: 300,
      rawData: concatBytes([
        writeU16(childKeyTag),
        new Uint8Array([8, 2]),
        childDsDigest
      ]),
      data: {
        keyTag: childKeyTag,
        algorithm: 8,
        digestType: 2,
        digest: childDsDigest
      }
    };
    const dsSig = await signedRrsig(RECORD_TYPES.DS, 'test', '.', rootKeyTag, rootPair.privateKey, [dsRecord]);
    const dnskeyRecord = {
      name: 'test',
      type: RECORD_TYPES.DNSKEY,
      ttl: 300,
      rawData: childDnskey,
      data: {
        flags: 257,
        protocol: 3,
        algorithm: 8,
        publicKey: childDnskey.slice(4)
      }
    };
    const dnskeySig = await signedRrsig(RECORD_TYPES.DNSKEY, 'test', 'test', childKeyTag, childPair.privateKey, [dnskeyRecord]);
    const answer = aRecord('www.test');
    const answerSig = await signedRrsig(RECORD_TYPES.A, 'www.test', 'test', childKeyTag, childPair.privateKey, [answer]);
    const fetched: string[] = [];
    await validateDnssecResponse({
      rcode: 0,
      answers: [answer, rrsigRecord('www.test', answerSig)],
      authorities: []
    }, 'www.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: '.',
        rawData: rootDnskey
      }],
      now: 2e3,
      fetch: async (name, qtype) => {
        fetched.push(`${name}:${qtype}`);
        if (name === '.' && qtype === RECORD_TYPES.DNSKEY) {
          return {
            rcode: 0,
            answers: [rootDnskeyRecord, rrsigRecord('.', rootDnskeySig)],
            authorities: []
          };
        }
        if (name === 'test' && qtype === RECORD_TYPES.DS) {
          return {
            rcode: 0,
            answers: [dsRecord, rrsigRecord('test', dsSig)],
            authorities: []
          };
        }
        if (name === 'test' && qtype === RECORD_TYPES.DNSKEY) {
          return {
            rcode: 0,
            answers: [dnskeyRecord, rrsigRecord('test', dnskeySig)],
            authorities: []
          };
        }
        throw new Error(`unexpected fetch ${name}:${qtype}`);
      }
    });
    t.equal(fetched[0], `.:${RECORD_TYPES.DNSKEY}`, 'root DNSKEY RRset is fetched before child validation');
  });
  it('validateDnssecResponse accepts a positive CNAME answer covered by DNSSEC', async () => {
    const keyPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const dnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', keyPair.publicKey) as {
      n: string;
      e: string;
    });
    const keyTag = dnskeyKeyTag(dnskey);
    const cname = {
      name: 'www.test',
      type: RECORD_TYPES.CNAME,
      ttl: 300,
      rawData: _encodeName('edge.test'),
      data: 'edge.test'
    };
    const cnameSig = await signedRrsig(RECORD_TYPES.CNAME, 'www.test', 'test', keyTag, keyPair.privateKey, [cname]);
    await validateDnssecResponse({
      rcode: 0,
      answers: [cname, rrsigRecord('www.test', cnameSig)],
      authorities: []
    }, 'www.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: 'test',
        rawData: dnskey
      }],
      now: 2e3,
      fetch: async () => {
        throw new Error('unexpected fetch');
      }
    });
  });
  it('validateSignedResponse rejects expired and not-yet-valid RRSIGs', async (t) => {
    const keyPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const dnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', keyPair.publicKey) as {
      n: string;
      e: string;
    });
    const keyTag = dnskeyKeyTag(dnskey);
    const answer = aRecord('www.test');
    async function responseWithWindow(inception: number, expiration: number) {
      const rrsig = {
        typeCovered: RECORD_TYPES.A,
        algorithm: 8,
        labels: 2,
        originalTtl: 300,
        expiration,
        inception,
        keyTag,
        signerName: 'test',
        signature: new Uint8Array()
      };
      rrsig.signature = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-V1_5' }, keyPair.privateKey, rrsigSignedData(rrsig, [answer])));
      return {
        id: 1,
        flags: 33152,
        rcode: 0,
        truncated: false,
        answers: [answer, rrsigRecord('www.test', rrsig)],
        authorities: [],
        additionals: []
      };
    }
    await t.rejects(async () => validateSignedResponse(await responseWithWindow(1, 1999), 'www.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: 'test',
        rawData: dnskey
      }],
      now: 2e3
    }), (err) => (err as {
      code?: string;
    }).code === 'EDNSSEC', 'expired RRSIG rejects');
    await t.rejects(async () => validateSignedResponse(await responseWithWindow(2001, 4102444800), 'www.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: 'test',
        rawData: dnskey
      }],
      now: 2e3
    }), (err) => (err as {
      code?: string;
    }).code === 'EDNSSEC', 'not-yet-valid RRSIG rejects');
  });
  it('validateDnssecResponse rejects a DS digest mismatch', async (t) => {
    const rootPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const childPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const rootDnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', rootPair.publicKey) as {
      n: string;
      e: string;
    });
    const childDnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', childPair.publicKey) as {
      n: string;
      e: string;
    });
    const rootKeyTag = dnskeyKeyTag(rootDnskey);
    const childKeyTag = dnskeyKeyTag(childDnskey);
    const badDigest = new Uint8Array(32).fill(170);
    const dsRecord = {
      name: 'test',
      type: RECORD_TYPES.DS,
      ttl: 300,
      rawData: concatBytes([
        writeU16(childKeyTag),
        new Uint8Array([8, 2]),
        badDigest
      ]),
      data: {
        keyTag: childKeyTag,
        algorithm: 8,
        digestType: 2,
        digest: badDigest
      }
    };
    const dsSig = await signedRrsig(RECORD_TYPES.DS, 'test', '.', rootKeyTag, rootPair.privateKey, [dsRecord]);
    const dnskeyRecord = {
      name: 'test',
      type: RECORD_TYPES.DNSKEY,
      ttl: 300,
      rawData: childDnskey,
      data: {
        flags: 257,
        protocol: 3,
        algorithm: 8,
        publicKey: childDnskey.slice(4)
      }
    };
    const answer = aRecord('www.test');
    await t.rejects(() => validateDnssecResponse({
      rcode: 0,
      answers: [answer],
      authorities: []
    }, 'www.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: '.',
        rawData: rootDnskey
      }],
      now: 2e3,
      fetch: async (name, qtype) => {
        if (name === 'test' && qtype === RECORD_TYPES.DS) {
          return {
            rcode: 0,
            answers: [dsRecord, rrsigRecord('test', dsSig)],
            authorities: []
          };
        }
        if (name === 'test' && qtype === RECORD_TYPES.DNSKEY) {
          return {
            rcode: 0,
            answers: [dnskeyRecord],
            authorities: []
          };
        }
        throw new Error(`unexpected fetch ${name}:${qtype}`);
      }
    }), (err) => (err as {
      code?: string;
    }).code === 'EDNSSEC', 'DS digest mismatch rejects the chain');
  });
  it('validateSignedResponse rejects unsupported-only signatures and falls back to a supported signature', async (t) => {
    const keyPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const dnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', keyPair.publicKey) as {
      n: string;
      e: string;
    });
    const keyTag = dnskeyKeyTag(dnskey);
    const answer = aRecord('www.test');
    const unsupported = {
      typeCovered: RECORD_TYPES.A,
      algorithm: 253,
      labels: 2,
      originalTtl: 300,
      expiration: 4102444800,
      inception: 1,
      keyTag,
      signerName: 'test',
      signature: new Uint8Array([
        1,
        2,
        3
      ])
    };
    const supported = await signedRrsig(RECORD_TYPES.A, 'www.test', 'test', keyTag, keyPair.privateKey, [answer]);
    const unsupportedResponse = {
      id: 1,
      flags: 33152,
      rcode: 0,
      truncated: false,
      answers: [answer, rrsigRecord('www.test', unsupported)],
      authorities: [],
      additionals: []
    };
    await t.rejects(() => validateSignedResponse(unsupportedResponse, 'www.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: 'test',
        rawData: dnskey
      }],
      now: 2e3
    }), (err) => (err as {
      code?: string;
    }).code === 'EDNSSEC', 'unsupported-only signature rejects');
    await validateSignedResponse({
      ...unsupportedResponse,
      answers: [
        answer,
        rrsigRecord('www.test', unsupported),
        rrsigRecord('www.test', supported)
      ]
    }, 'www.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: 'test',
        rawData: dnskey
      }],
      now: 2e3
    });
  });
  it('validateDnssecResponse reuses bounded DNSSEC cache entries until TTL expiry', async (t) => {
    const rootPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const childPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const rootDnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', rootPair.publicKey) as {
      n: string;
      e: string;
    });
    const childDnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', childPair.publicKey) as {
      n: string;
      e: string;
    });
    const rootKeyTag = dnskeyKeyTag(rootDnskey);
    const childKeyTag = dnskeyKeyTag(childDnskey);
    const childDsDigest = await digestDnskey('test', childDnskey, 2);
    const dsRecord = {
      name: 'test',
      type: RECORD_TYPES.DS,
      ttl: 120,
      rawData: concatBytes([
        writeU16(childKeyTag),
        new Uint8Array([8, 2]),
        childDsDigest
      ]),
      data: {
        keyTag: childKeyTag,
        algorithm: 8,
        digestType: 2,
        digest: childDsDigest
      }
    };
    const dsSig = await signedRrsig(RECORD_TYPES.DS, 'cached.test', '.', rootKeyTag, rootPair.privateKey, [dsRecord]);
    const dnskeyRecord = {
      name: 'test',
      type: RECORD_TYPES.DNSKEY,
      ttl: 120,
      rawData: childDnskey,
      data: {
        flags: 257,
        protocol: 3,
        algorithm: 8,
        publicKey: childDnskey.slice(4)
      }
    };
    const dnskeySig = await signedRrsig(RECORD_TYPES.DNSKEY, 'test', 'test', childKeyTag, childPair.privateKey, [dnskeyRecord]);
    const answer = aRecord('www.test');
    const answerSig = await signedRrsig(RECORD_TYPES.A, 'www.test', 'test', childKeyTag, childPair.privateKey, [answer]);
    let chainFetchCount = 0;
    const cache = {
      entries: new Map(),
      maxEntries: 4
    };
    async function run(now: number) {
      await validateDnssecResponse({
        rcode: 0,
        answers: [answer, rrsigRecord('www.test', answerSig)],
        authorities: []
      }, 'www.test', RECORD_TYPES.A, {
        trustAnchors: [{
          name: '.',
          rawData: rootDnskey
        }],
        now,
        cache,
        fetch: async (name, qtype) => {
          if (name === 'test' && qtype === RECORD_TYPES.DS) {
            chainFetchCount++;
            return {
              rcode: 0,
              answers: [dsRecord, rrsigRecord('test', dsSig)],
              authorities: []
            };
          }
          if (name === 'test' && qtype === RECORD_TYPES.DNSKEY) {
            chainFetchCount++;
            return {
              rcode: 0,
              answers: [dnskeyRecord, rrsigRecord('test', dnskeySig)],
              authorities: []
            };
          }
          throw new Error(`unexpected fetch ${name}:${qtype}`);
        }
      });
    }
    await run(2e3);
    await run(2050);
    t.equal(chainFetchCount, 2, 'DS and DNSKEY fetches are reused while cache entry is fresh');
    await run(2200);
    t.equal(chainFetchCount, 4, 'expired chain cache entries are refetched');
  });
  it('validateDnssecResponse rejects an indeterminate DS lookup without a signed denial proof', async (t) => {
    const rootPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const rootDnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', rootPair.publicKey) as {
      n: string;
      e: string;
    });
    const unsignedAnswer = aRecord('www.insecure.test');
    await t.rejects(() => validateDnssecResponse({
      rcode: 0,
      answers: [unsignedAnswer],
      authorities: []
    }, 'www.insecure.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: '.',
        rawData: rootDnskey
      }],
      now: 2e3,
      fetch: async (name, qtype) => {
        if (name === 'test' && qtype === RECORD_TYPES.DS) return {
          rcode: 0,
          answers: [],
          authorities: []
        };
        throw new Error(`unexpected fetch ${name}:${qtype}`);
      }
    }), (err) => (err as {
      code?: string;
    }).code === 'EDNSSEC', 'missing DS denial proof rejects as indeterminate');
  });
  it('validateDnssecResponse accepts an unsigned child only with a signed NSEC DS-negative proof', async (t) => {
    const rootPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const rootDnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', rootPair.publicKey) as {
      n: string;
      e: string;
    });
    const rootKeyTag = dnskeyKeyTag(rootDnskey);
    const nsec = nsecRecord('test', 'zzz.test', [
      RECORD_TYPES.NS,
      RECORD_TYPES.RRSIG,
      RECORD_TYPES.NSEC
    ]);
    const nsecSig = await signedRrsig(RECORD_TYPES.NSEC, 'test', '.', rootKeyTag, rootPair.privateKey, [nsec]);
    const unsignedAnswer = aRecord('www.insecure.test');
    await validateDnssecResponse({
      rcode: 0,
      answers: [unsignedAnswer],
      authorities: []
    }, 'www.insecure.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: '.',
        rawData: rootDnskey
      }],
      now: 2e3,
      fetch: async (name, qtype) => {
        if (name === 'test' && qtype === RECORD_TYPES.DS) {
          return {
            rcode: 0,
            answers: [],
            authorities: [nsec, rrsigRecord('test', nsecSig)]
          };
        }
        throw new Error(`unexpected fetch ${name}:${qtype}`);
      }
    });
  });
  it('validateDnssecResponse validates NSEC NODATA only when the signed NSEC proves the type is absent', async (t) => {
    const keyPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const dnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', keyPair.publicKey) as {
      n: string;
      e: string;
    });
    const keyTag = dnskeyKeyTag(dnskey);
    const validNsec = nsecRecord('www.test', 'zzz.test', [
      RECORD_TYPES.A,
      RECORD_TYPES.RRSIG,
      RECORD_TYPES.NSEC
    ]);
    const validSig = await signedRrsig(RECORD_TYPES.NSEC, 'www.test', 'test', keyTag, keyPair.privateKey, [validNsec]);
    await validateDnssecResponse({
      rcode: 0,
      answers: [],
      authorities: [validNsec, rrsigRecord('www.test', validSig)]
    }, 'www.test', RECORD_TYPES.AAAA, {
      trustAnchors: [{
        name: 'test',
        rawData: dnskey
      }],
      now: 2e3,
      fetch: async () => {
        throw new Error('unexpected fetch');
      }
    });
    const invalidNsec = nsecRecord('www.test', 'zzz.test', [
      RECORD_TYPES.AAAA,
      RECORD_TYPES.RRSIG,
      RECORD_TYPES.NSEC
    ]);
    const invalidSig = await signedRrsig(RECORD_TYPES.NSEC, 'www.test', 'test', keyTag, keyPair.privateKey, [invalidNsec]);
    await t.rejects(() => validateDnssecResponse({
      rcode: 0,
      answers: [],
      authorities: [invalidNsec, rrsigRecord('www.test', invalidSig)]
    }, 'www.test', RECORD_TYPES.AAAA, {
      trustAnchors: [{
        name: 'test',
        rawData: dnskey
      }],
      now: 2e3,
      fetch: async () => {
        throw new Error('unexpected fetch');
      }
    }), (err) => (err as {
      code?: string;
    }).code === 'EDNSSEC', 'NSEC listing requested type cannot prove NODATA');
  });
  it('validateDnssecResponse requires NSEC closest-encloser and wildcard proofs for NXDOMAIN', async (t) => {
    const keyPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const dnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', keyPair.publicKey) as {
      n: string;
      e: string;
    });
    const keyTag = dnskeyKeyTag(dnskey);
    const closest = nsecRecord('test', '*.test', [
      RECORD_TYPES.SOA,
      RECORD_TYPES.NS,
      RECORD_TYPES.RRSIG,
      RECORD_TYPES.NSEC
    ]);
    const nextCloser = nsecRecord('a.test', 'z.test', [RECORD_TYPES.RRSIG, RECORD_TYPES.NSEC]);
    const wildcard = nsecRecord('*.test', 'a.test', [RECORD_TYPES.RRSIG, RECORD_TYPES.NSEC]);
    const closestSig = await signedRrsig(RECORD_TYPES.NSEC, 'test', 'test', keyTag, keyPair.privateKey, [closest]);
    const nextCloserSig = await signedRrsig(RECORD_TYPES.NSEC, 'a.test', 'test', keyTag, keyPair.privateKey, [nextCloser]);
    const wildcardSig = await signedRrsig(RECORD_TYPES.NSEC, '*.test', 'test', keyTag, keyPair.privateKey, [wildcard]);
    await validateDnssecResponse({
      rcode: 3,
      answers: [],
      authorities: [
        closest,
        rrsigRecord('test', closestSig),
        nextCloser,
        rrsigRecord('a.test', nextCloserSig),
        wildcard,
        rrsigRecord('*.test', wildcardSig)
      ]
    }, 'missing.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: 'test',
        rawData: dnskey
      }],
      now: 2e3,
      fetch: async () => {
        throw new Error('unexpected fetch');
      }
    });
    await t.rejects(() => validateDnssecResponse({
      rcode: 3,
      answers: [],
      authorities: [
        closest,
        rrsigRecord('test', closestSig),
        nextCloser,
        rrsigRecord('a.test', nextCloserSig)
      ]
    }, 'missing.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: 'test',
        rawData: dnskey
      }],
      now: 2e3,
      fetch: async () => {
        throw new Error('unexpected fetch');
      }
    }), (err) => (err as {
      code?: string;
    }).code === 'EDNSSEC', 'missing wildcard denial rejects NXDOMAIN proof');
  });
  it('validateDnssecResponse validates NSEC3 exact-match NODATA and rejects excessive iterations', async (t) => {
    const keyPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const dnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', keyPair.publicKey) as {
      n: string;
      e: string;
    });
    const keyTag = dnskeyKeyTag(dnskey);
    const salt = new Uint8Array([
      1,
      2,
      3,
      4
    ]);
    const ownerHash = await nsec3Hash('www.test', salt, 2);
    const nextHash = await nsec3Hash('zzz.test', salt, 2);
    const proof = nsec3Record(ownerHash, 'test', nextHash, [RECORD_TYPES.A, RECORD_TYPES.RRSIG], {
      salt,
      iterations: 2
    });
    const proofSig = await signedRrsig(RECORD_TYPES.NSEC3, proof.name, 'test', keyTag, keyPair.privateKey, [proof]);
    await validateDnssecResponse({
      rcode: 0,
      answers: [],
      authorities: [proof, rrsigRecord(proof.name, proofSig)]
    }, 'www.test', RECORD_TYPES.AAAA, {
      trustAnchors: [{
        name: 'test',
        rawData: dnskey
      }],
      now: 2e3,
      fetch: async () => {
        throw new Error('unexpected fetch');
      }
    });
    const excessive = nsec3Record(ownerHash, 'test', nextHash, [RECORD_TYPES.A, RECORD_TYPES.RRSIG], {
      salt,
      iterations: 251
    });
    const excessiveSig = await signedRrsig(RECORD_TYPES.NSEC3, excessive.name, 'test', keyTag, keyPair.privateKey, [excessive]);
    await t.rejects(() => validateDnssecResponse({
      rcode: 0,
      answers: [],
      authorities: [excessive, rrsigRecord(excessive.name, excessiveSig)]
    }, 'www.test', RECORD_TYPES.AAAA, {
      trustAnchors: [{
        name: 'test',
        rawData: dnskey
      }],
      now: 2e3,
      fetch: async () => {
        throw new Error('unexpected fetch');
      }
    }), (err) => (err as {
      code?: string;
    }).code === 'EDNSSEC', 'excessive NSEC3 iterations reject');
  });
  it('validateDnssecResponse validates NSEC3 NXDOMAIN closest-encloser and wildcard proofs', async (t) => {
    const keyPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const dnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', keyPair.publicKey) as {
      n: string;
      e: string;
    });
    const keyTag = dnskeyKeyTag(dnskey);
    const salt = new Uint8Array([
      9,
      8,
      7,
      6
    ]);
    const closest = nsec3Record(await nsec3Hash('test', salt, 1), 'test', new Uint8Array(20).fill(255), [
      RECORD_TYPES.SOA,
      RECORD_TYPES.NS,
      RECORD_TYPES.RRSIG
    ], {
      salt,
      iterations: 1
    });
    const nextCloserCover = nsec3Record(new Uint8Array(20), 'test', new Uint8Array(20).fill(255), [RECORD_TYPES.RRSIG], {
      salt,
      iterations: 1
    });
    const wildcard = nsec3Record(await nsec3Hash('*.test', salt, 1), 'test', new Uint8Array(20).fill(255), [RECORD_TYPES.RRSIG], {
      salt,
      iterations: 1
    });
    const closestSig = await signedRrsig(RECORD_TYPES.NSEC3, closest.name, 'test', keyTag, keyPair.privateKey, [closest]);
    const nextCloserSig = await signedRrsig(RECORD_TYPES.NSEC3, nextCloserCover.name, 'test', keyTag, keyPair.privateKey, [nextCloserCover]);
    const wildcardSig = await signedRrsig(RECORD_TYPES.NSEC3, wildcard.name, 'test', keyTag, keyPair.privateKey, [wildcard]);
    await validateDnssecResponse({
      rcode: 3,
      answers: [],
      authorities: [
        closest,
        rrsigRecord(closest.name, closestSig),
        nextCloserCover,
        rrsigRecord(nextCloserCover.name, nextCloserSig),
        wildcard,
        rrsigRecord(wildcard.name, wildcardSig)
      ]
    }, 'missing.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: 'test',
        rawData: dnskey
      }],
      now: 2e3,
      fetch: async () => {
        throw new Error('unexpected fetch');
      }
    });
    await t.rejects(() => validateDnssecResponse({
      rcode: 3,
      answers: [],
      authorities: [
        closest,
        rrsigRecord(closest.name, closestSig),
        nextCloserCover,
        rrsigRecord(nextCloserCover.name, nextCloserSig)
      ]
    }, 'missing.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: 'test',
        rawData: dnskey
      }],
      now: 2e3,
      fetch: async () => {
        throw new Error('unexpected fetch');
      }
    }), (err) => (err as {
      code?: string;
    }).code === 'EDNSSEC', 'missing NSEC3 wildcard proof rejects NXDOMAIN');
  });
  it('validateDnssecResponse accepts NSEC3 opt-out DS-negative proof for insecure delegation', async (t) => {
    const rootPair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-V1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([
        1,
        0,
        1
      ]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']) as {
      privateKey: CryptoKey;
      publicKey: CryptoKey;
    };
    const rootDnskey = dnskeyFromRsaJwk(await crypto.subtle.exportKey('jwk', rootPair.publicKey) as {
      n: string;
      e: string;
    });
    const rootKeyTag = dnskeyKeyTag(rootDnskey);
    const salt = new Uint8Array([
      5,
      4,
      3,
      2
    ]);
    const optOut = nsec3Record(new Uint8Array(20), 'test', new Uint8Array(20).fill(255), [RECORD_TYPES.RRSIG], {
      flags: 1,
      salt,
      iterations: 1
    });
    const optOutSig = await signedRrsig(RECORD_TYPES.NSEC3, optOut.name, '.', rootKeyTag, rootPair.privateKey, [optOut]);
    await validateDnssecResponse({
      rcode: 0,
      answers: [aRecord('www.child.test')],
      authorities: []
    }, 'www.child.test', RECORD_TYPES.A, {
      trustAnchors: [{
        name: '.',
        rawData: rootDnskey
      }],
      now: 2e3,
      fetch: async (name, qtype) => {
        if (name === 'test' && qtype === RECORD_TYPES.DS) {
          return {
            rcode: 0,
            answers: [],
            authorities: [optOut, rrsigRecord(optOut.name, optOutSig)]
          };
        }
        throw new Error(`unexpected fetch ${name}:${qtype}`);
      }
    });
  });
});
