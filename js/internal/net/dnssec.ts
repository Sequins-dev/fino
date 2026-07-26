/**
 * Internal DNSSEC helpers for `fino:net/dns`.
 *
 * Learn more:
 * - DNSSEC protocol modifications: https://www.rfc-editor.org/rfc/rfc4035
 * - DNSSEC resource records: https://www.rfc-editor.org/rfc/rfc4034
 *
 * This module keeps canonical DNS wire encoding and DNSSEC math away from the
 * resolver transport code. It intentionally has no socket dependencies so the
 * primitives can be tested with static fixtures.
 *
 * Release verification keeps external DNSSEC checks in
 * `tests/net/dns-live.test.ts`, gated by `FINO_DNS_LIVE=1`. That lane should
 * validate a signed domain and reject a bogus signed domain against an
 * explicitly selected recursive resolver (`FINO_DNS_SERVER`) so normal CI and
 * local tests remain deterministic.
 *
 * Supported DS digest types are SHA-1 (`1`), SHA-256 (`2`), and SHA-384 (`4`).
 * Supported DNSKEY/RRSIG algorithms are RSASHA256 (`8`), RSASHA512 (`10`),
 * ECDSAP256SHA256 (`13`), ECDSAP384SHA384 (`14`), and Ed25519 (`15`).
 * Unsupported-only signatures and unsupported DS digest types are treated as
 * indeterminate and reject validation unless another supported signature or
 * digest completes the chain. NSEC3 validation supports SHA-1 hashes only and
 * rejects records above the module iteration cap.
 *
 * ```ts no_run
 * import { validateDnssecResponse, ROOT_TRUST_ANCHORS } from 'internal:net/dnssec';
 *
 * // `fetch` performs an authenticated DNS query and decodes the wire response
 * // into { rcode, answers, authorities } records with parsed RRSIG/DS data.
 * const A = 1;
 * await validateDnssecResponse(response, 'example.com', A, {
 *   trustAnchors: ROOT_TRUST_ANCHORS,
 *   fetch: (name, qtype) => resolver.queryDnssec(name, qtype),
 * });
 * // resolves → authenticated (secure or provably insecure); throws EDNSSEC → bogus
 * ```
 *
 * @internal
 */
import { atob, btoa, TextEncoder } from '../../globals/encoding.ts';
type RrsetRecord = {
  name: string;
  type: number;
  ttl: number;
  rawData: Uint8Array;
};
type RrsigTiming = {
  originalTtl: number;
};
type RrsigData = {
  typeCovered: number;
  algorithm: number;
  labels: number;
  originalTtl: number;
  expiration: number;
  inception: number;
  keyTag: number;
  signerName: string;
  signature: Uint8Array;
};
type DnskeyInput = {
  name: string;
  rawData: Uint8Array;
};
type DnssecRecord = {
  name: string;
  type: number;
  ttl: number;
  rawData: Uint8Array;
  data?: unknown;
};
type DnssecResponse = {
  rcode: number;
  answers: DnssecRecord[];
  authorities: DnssecRecord[];
};
type ValidationOptions = {
  trustAnchors: DnskeyInput[];
  now?: number;
};
type ChainValidationOptions = {
  trustAnchors: DnskeyInput[];
  fetch: (name: string, qtype: number) => Promise<DnssecResponse>;
  cache?: DnssecCache;
  now?: number;
  maxFetches?: number;
  maxDepth?: number;
};
/**
 * Bounded LRU cache of validated per-zone DNSKEY sets, shared across chain
 * validations.
 *
 * `validateDnssecResponse` threads a cache through its options so repeated
 * lookups for the same zone reuse an already-authenticated DNSKEY RRset instead
 * of re-walking the delegation from the root. Each entry maps a zone cache key
 * to either the trusted keys for that zone or `null` (the zone was proven
 * insecure), together with an `expiresAt` UNIX timestamp derived from the
 * shortest record TTL and RRSIG expiration in the response that produced it.
 * Entries at or past `expiresAt` are discarded on access. `maxEntries` bounds
 * the map, evicting the least recently used entry once the size exceeds it
 * (default 256).
 *
 * Create one cache per resolver instance and reuse it across queries; start
 * with an empty `Map`.
 *
 * ```ts no_run
 * import { validateDnssecResponse, ROOT_TRUST_ANCHORS, DnssecCache } from 'internal:net/dnssec';
 *
 * const cache: DnssecCache = { entries: new Map(), maxEntries: 512 };
 * await validateDnssecResponse(response, 'example.com', 1, {
 *   trustAnchors: ROOT_TRUST_ANCHORS,
 *   fetch,
 *   cache,
 * });
 * ```
 */
export type DnssecCache = {
  entries: Map<
    string,
    {
      value: DnskeyInput[] | null;
      expiresAt: number;
    }
  >;
  maxEntries?: number;
};
const QTYPE_CNAME = 5;
const QTYPE_DS = 43;
const QTYPE_RRSIG = 46;
const QTYPE_NSEC = 47;
const QTYPE_DNSKEY = 48;
const QTYPE_NSEC3 = 50;
const MAX_NSEC3_ITERATIONS = 150;
const BASE32HEX = '0123456789ABCDEFGHIJKLMNOPQRSTUV';
function base64Decode(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function dnskeyRdata(flags: number, algorithm: number, publicKeyBase64: string): Uint8Array {
  return concatBytes([
    writeU16(flags),
    new Uint8Array([3, algorithm]),
    base64Decode(publicKeyBase64),
  ]);
}
/**
 * The IANA DNS root zone trust anchors, expressed as the DNSKEY inputs they
 * authenticate.
 *
 * These are the currently published root zone key-signing keys (KSKs) from
 * https://data.iana.org/root-anchors/root-anchors.xml (fetched 2026-06-19),
 * keyed to the root zone (`.`). Pass them as `trustAnchors` to
 * `validateDnssecResponse` or `validateSignedResponse` to anchor a chain of
 * trust at the root. Each entry's `rawData` is canonical DNSKEY RDATA (flags,
 * protocol, algorithm, public key), so it can be key-tagged and matched against
 * DS records directly.
 *
 * ```ts no_run
 * import { validateDnssecResponse, ROOT_TRUST_ANCHORS } from 'internal:net/dnssec';
 *
 * await validateDnssecResponse(response, 'example.com', 1, {
 *   trustAnchors: ROOT_TRUST_ANCHORS,
 *   fetch,
 * });
 * ```
 */
export const ROOT_TRUST_ANCHORS: DnskeyInput[] = [
  {
    name: '.',
    rawData: dnskeyRdata(
      257,
      8,
      'AwEAAaz/tAm8yTn4Mfeh5eyI96WSVexTBAvkMgJzkKTOiW1vkIbzxeF3+/4RgWOq7HrxRixHlFlExOLAJr5emLvN7SWXgnLh4+B5xQlNVz8Og8kvArMtNROxVQuCaSnIDdD5LKyWbRd2n9WGe2R8PzgCmr3EgVLrjyBxWezF0jLHwVN8efS3rCj/EWgvIWgb9tarpVUDK/b58Da+sqqls3eNbuv7pr+eoZG+SrDK6nWeL3c6H5Apxz7LjVc1uTIdsIXxuOLYA4/ilBmSVIzuDWfdRUfhHdY6+cn8HFRm+2hM8AnXGXws9555KrUB5qihylGa8subX2Nn6UwNR1AkUTV74bU=',
    ),
  },
  {
    name: '.',
    rawData: dnskeyRdata(
      257,
      8,
      'AwEAAa96jeuknZlaeSrvyAJj6ZHv28hhOKkx3rLGXVaC6rXTsDc449/cidltpkyGwCJNnOAlFNKF2jBosZBU5eeHspaQWOmOElZsjICMQMC3aeHbGiShvZsx4wMYSjH8e7Vrhbu6irwCzVBApESjbUdpWWmEnhathWu1jo+siFUiRAAxm9qyJNg/wOZqqzL/dL/q8PkcRU5oUKEpUge71M3ej2/7CPqpdVwuMoTvoB+ZOT4YeGyxMvHmbrxlFzGOHOijtzN+u1TQNatX2XBuzZNQ1K+s2CXkPIZo7s6JgZyvaBevYtxPvYLw4z9mR7K2vaF18UYH9Z9GNUUeayffKC73PYc=',
    ),
  },
];
const textEncoder = new TextEncoder();
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
function writeU32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < len; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return a.byteLength - b.byteLength;
}
function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function dnssecError(message: string): Error & {
  code: string;
} {
  const err = new Error(`dnssec: ${message}`) as Error & {
    code: string;
  };
  err.code = 'EDNSSEC';
  return err;
}
async function fetchForValidation(
  options: ChainValidationOptions,
  name: string,
  qtype: number,
): Promise<DnssecResponse> {
  try {
    return await options.fetch(name, qtype);
  } catch (err) {
    if (
      (
        err as {
          code?: string;
        }
      )?.code === 'EDNSSEC'
    )
      throw err;
    throw dnssecError(`validation fetch failed for ${name} type ${qtype}`);
  }
}
/**
 * Encode a domain name in DNSSEC canonical wire format.
 *
 * DNSSEC canonical form lowercases ASCII owner labels and strips a trailing
 * presentation root dot before producing normal length-prefixed DNS wire
 * labels. The root name (`.` or the empty string) encodes as a single zero
 * byte. IDNA conversion is intentionally out of scope for this helper.
 *
 * Throws if any label exceeds 63 bytes, which the length-prefixed wire format
 * cannot represent.
 *
 * ```ts no_run
 * import { canonicalName } from 'internal:net/dnssec';
 *
 * canonicalName('Example.COM.');
 * // → 07 65 78 61 6d 70 6c 65 03 63 6f 6d 00  (7 "example" 3 "com" 0)
 * ```
 */
export function canonicalName(name: string): Uint8Array {
  const normalized = (name.endsWith('.') ? name.slice(0, -1) : name).toLowerCase();
  if (normalized.length === 0) return new Uint8Array([0]);
  const labels = normalized.split('.');
  let totalLen = 1;
  const encodedLabels: Uint8Array[] = [];
  for (const label of labels) {
    if (label.length === 0) continue;
    const bytes = textEncoder.encode(label);
    if (bytes.byteLength > 63) throw new Error(`DNSSEC: label too long: '${label}'`);
    totalLen += 1 + bytes.byteLength;
    encodedLabels.push(bytes);
  }
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const bytes of encodedLabels) {
    out[offset++] = bytes.byteLength;
    out.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return out;
}
/**
 * Compute the RFC 4034 appendix B key tag for a DNSKEY's RDATA.
 *
 * The key tag is a 16-bit checksum over the DNSKEY RDATA used to cheaply
 * correlate a DNSKEY with the DS records and RRSIGs that reference it. It is
 * not unique — two keys can share a tag — so a tag match only narrows the
 * candidates; callers still confirm the full DS digest or signature. This
 * computation is the general form covering every algorithm except the obsolete
 * algorithm 1, which used a different tag derivation.
 *
 * ```ts no_run
 * import { dnskeyKeyTag } from 'internal:net/dnssec';
 *
 * const tag = dnskeyKeyTag(dnskey.rawData);
 * if (tag === rrsig.keyTag) {
 *   // candidate key — verify the signature to be sure
 * }
 * ```
 */
export function dnskeyKeyTag(dnskeyRdata: Uint8Array): number {
  let ac = 0;
  for (let i = 0; i < dnskeyRdata.byteLength; i++) {
    ac += (i & 1) === 0 ? dnskeyRdata[i]! << 8 : dnskeyRdata[i]!;
  }
  ac += (ac >> 16) & 65535;
  return ac & 65535;
}
/**
 * Calculate a DS record digest over an owner name and DNSKEY RDATA.
 *
 * The DS digest is `hash(canonicalName(owner) || dnskeyRdata)`. A parent zone
 * publishes this digest to commit to a child zone's key-signing key; recomputing
 * it and comparing against the published DS digest links parent and child in the
 * chain of trust. Digest type `1` is SHA-1 for legacy validation, `2` is
 * SHA-256, and `4` is SHA-384. Other digest types are intentionally unsupported.
 *
 * Throws if `digestType` is not one of the supported values.
 *
 * ```ts no_run
 * import { digestDnskey, dnskeyKeyTag } from 'internal:net/dnssec';
 *
 * const digest = await digestDnskey('example.com', key.rawData, ds.digestType);
 * const matches =
 *   ds.keyTag === dnskeyKeyTag(key.rawData) &&
 *   digest.length === ds.digest.length &&
 *   digest.every((b, i) => b === ds.digest[i]);
 * ```
 */
export async function digestDnskey(
  ownerName: string,
  dnskeyRdata: Uint8Array,
  digestType: number,
): Promise<Uint8Array> {
  let hash: string;
  switch (digestType) {
    case 1:
      hash = 'SHA-1';
      break;
    case 2:
      hash = 'SHA-256';
      break;
    case 4:
      hash = 'SHA-384';
      break;
    default:
      throw new Error(`DNSSEC: unsupported DS digest type ${digestType}`);
  }
  const input = concatBytes([canonicalName(ownerName), dnskeyRdata]);
  return new Uint8Array(await crypto.subtle.digest(hash, input));
}
/**
 * Serialize an RRset in DNSSEC canonical order for RRSIG verification.
 *
 * Each RR is encoded as owner name, type, class IN, the RRSIG original TTL,
 * RDLENGTH, and exact RDATA, and the encoded records are then sorted into
 * canonical byte order. When the RRSIG carries a `labels` count smaller than
 * the owner's label count the RRset was signed under a wildcard, so the owner
 * name is rewritten to `*.<closest-encloser>` before encoding. The returned
 * data does not include the RRSIG metadata prefix; `rrsigSignedData` prepends
 * that when building the exact signed input.
 *
 * ```ts no_run
 * import { canonicalRrsetData } from 'internal:net/dnssec';
 *
 * // Minimal timing input reuses the RRSIG's original TTL for every record.
 * const body = canonicalRrsetData(records, { originalTtl: rrsig.originalTtl });
 * ```
 */
export function canonicalRrsetData(records: RrsetRecord[], rrsig: RrsigTiming): Uint8Array {
  const encoded = records.map((record) =>
    concatBytes([
      canonicalName(
        canonicalOwnerName(
          record.name,
          'labels' in rrsig ? (rrsig as RrsigData).labels : undefined,
        ),
      ),
      writeU16(record.type),
      writeU16(1),
      writeU32(rrsig.originalTtl),
      writeU16(record.rawData.byteLength),
      record.rawData,
    ]),
  );
  encoded.sort(compareBytes);
  return concatBytes(encoded);
}
/**
 * Check whether a decoded NSEC/NSEC3 type bitmap includes a record type.
 *
 * NSEC and NSEC3 records carry a bitmap of the RR types that exist at their
 * owner name. An authenticated denial proof uses this to show a queried type is
 * absent — the name exists but its bitmap does not cover the type.
 *
 * ```ts no_run
 * import { nsecCoversType } from 'internal:net/dnssec';
 *
 * const hasMx = nsecCoversType(nsec.types, 15); // does an MX exist at this name?
 * ```
 */
export function nsecCoversType(types: number[], type: number): boolean {
  return types.includes(type);
}
function labelCount(name: string): number {
  const normalized = name.endsWith('.') ? name.slice(0, -1) : name;
  if (normalized.length === 0) return 0;
  return normalized.split('.').filter(Boolean).length;
}
function canonicalOwnerName(name: string, rrsigLabels?: number): string {
  if (rrsigLabels === undefined) return name;
  const normalized = name.endsWith('.') ? name.slice(0, -1) : name;
  const labels = normalized.split('.').filter(Boolean);
  if (rrsigLabels >= labels.length) return name;
  return ['*', ...labels.slice(labels.length - rrsigLabels)].join('.');
}
/**
 * Build the exact byte string an RRSIG signs over an RRset.
 *
 * The signed data is the RRSIG RDATA up to but excluding the signature — type
 * covered, algorithm, labels, original TTL, expiration, inception, key tag, and
 * canonical signer name — followed by the canonical RRset encoding from
 * `canonicalRrsetData`. This is the precise input handed to the public-key
 * verify operation. `verifyRrsig` calls it internally, so callers rarely need
 * it directly; it is exported for building and testing custom verifiers.
 *
 * ```ts no_run
 * import { rrsigSignedData } from 'internal:net/dnssec';
 *
 * const signed = rrsigSignedData(rrsig, records);
 * const ok = await crypto.subtle.verify(algorithm, key, rrsig.signature, signed);
 * ```
 */
export function rrsigSignedData(rrsig: RrsigData, records: RrsetRecord[]): Uint8Array {
  return concatBytes([
    writeU16(rrsig.typeCovered),
    new Uint8Array([rrsig.algorithm, rrsig.labels]),
    writeU32(rrsig.originalTtl),
    writeU32(rrsig.expiration),
    writeU32(rrsig.inception),
    writeU16(rrsig.keyTag),
    canonicalName(rrsig.signerName),
    canonicalRrsetData(records, rrsig),
  ]);
}
function parseRsaDnskeyPublicKey(publicKey: Uint8Array): {
  exponent: Uint8Array;
  modulus: Uint8Array;
} {
  if (publicKey.byteLength < 2) throw new Error('DNSSEC: truncated RSA DNSKEY public key');
  let offset = 0;
  let exponentLength = publicKey[offset++]!;
  if (exponentLength === 0) {
    if (publicKey.byteLength < 3) throw new Error('DNSSEC: truncated RSA DNSKEY exponent length');
    exponentLength = (publicKey[offset++]! << 8) | publicKey[offset++]!;
  }
  if (exponentLength === 0 || offset + exponentLength >= publicKey.byteLength) {
    throw new Error('DNSSEC: invalid RSA DNSKEY exponent length');
  }
  return {
    exponent: publicKey.slice(offset, offset + exponentLength),
    modulus: publicKey.slice(offset + exponentLength),
  };
}
function dnskeyPublicData(dnskeyRdata: Uint8Array): {
  flags: number;
  protocol: number;
  algorithm: number;
  publicKey: Uint8Array;
} {
  if (dnskeyRdata.byteLength < 4) throw new Error('DNSSEC: truncated DNSKEY RDATA');
  return {
    flags: new DataView(
      dnskeyRdata.buffer,
      dnskeyRdata.byteOffset,
      dnskeyRdata.byteLength,
    ).getUint16(0, false),
    protocol: dnskeyRdata[2]!,
    algorithm: dnskeyRdata[3]!,
    publicKey: dnskeyRdata.slice(4),
  };
}
async function importDnskey(dnskeyRdata: Uint8Array): Promise<{
  key: CryptoKey;
  verifyAlgorithm: {
    name: string;
    hash?: string;
  };
}> {
  const dnskey = dnskeyPublicData(dnskeyRdata);
  if (dnskey.protocol !== 3) throw new Error('DNSSEC: invalid DNSKEY protocol');
  if (dnskey.algorithm === 8 || dnskey.algorithm === 10) {
    const { exponent, modulus } = parseRsaDnskeyPublicKey(dnskey.publicKey);
    const hash = dnskey.algorithm === 8 ? 'SHA-256' : 'SHA-512';
    const key = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'RSA',
        n: base64urlEncode(modulus),
        e: base64urlEncode(exponent),
        ext: true,
        key_ops: ['verify'],
      } as unknown as BufferSource,
      {
        name: 'RSASSA-PKCS1-V1_5',
        hash,
      },
      false,
      ['verify'],
    );
    return {
      key,
      verifyAlgorithm: { name: 'RSASSA-PKCS1-V1_5' },
    };
  }
  if (dnskey.algorithm === 13 || dnskey.algorithm === 14) {
    const curveBytes = dnskey.algorithm === 13 ? 32 : 48;
    if (dnskey.publicKey.byteLength !== curveBytes * 2)
      throw new Error('DNSSEC: invalid ECDSA DNSKEY length');
    const hash = dnskey.algorithm === 13 ? 'SHA-256' : 'SHA-384';
    const namedCurve = dnskey.algorithm === 13 ? 'P-256' : 'P-384';
    const key = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: namedCurve,
        x: base64urlEncode(dnskey.publicKey.slice(0, curveBytes)),
        y: base64urlEncode(dnskey.publicKey.slice(curveBytes)),
        ext: true,
        key_ops: ['verify'],
      } as unknown as BufferSource,
      {
        name: 'ECDSA',
        namedCurve,
        hash,
      },
      false,
      ['verify'],
    );
    return {
      key,
      verifyAlgorithm: {
        name: 'ECDSA',
        hash,
      },
    };
  }
  if (dnskey.algorithm === 15) {
    if (dnskey.publicKey.byteLength !== 32)
      throw new Error('DNSSEC: invalid Ed25519 DNSKEY length');
    const key = await crypto.subtle.importKey('raw', dnskey.publicKey, 'Ed25519', false, [
      'verify',
    ]);
    return {
      key,
      verifyAlgorithm: { name: 'Ed25519' },
    };
  }
  throw new Error(`DNSSEC: unsupported DNSKEY algorithm ${dnskey.algorithm}`);
}
/**
 * Verify a single RRSIG over an RRset against one candidate DNSKEY.
 *
 * Returns `true` only when every check passes: `now` falls within the
 * signature's inception/expiration window, the DNSKEY's key tag and algorithm
 * match the RRSIG, the key's owner name equals the RRSIG signer name, an
 * Ed25519 (algorithm 15) signature is exactly 64 bytes, and the public-key
 * verification of `rrsigSignedData` succeeds. Any mismatch, an unsupported key
 * algorithm, or a malformed key returns `false` rather than throwing — a bogus
 * signature is a soft failure the caller aggregates across candidate keys.
 * `now` is a UNIX timestamp in seconds and defaults to the current time.
 *
 * Supported algorithms are RSASHA256 (8), RSASHA512 (10), ECDSAP256SHA256
 * (13), ECDSAP384SHA384 (14), and Ed25519 (15).
 *
 * ```ts no_run
 * import { verifyRrsig } from 'internal:net/dnssec';
 *
 * let authentic = false;
 * for (const key of zoneKeys) {
 *   if (await verifyRrsig(rrsig, records, key)) {
 *     authentic = true;
 *     break;
 *   }
 * }
 * ```
 */
export async function verifyRrsig(
  rrsig: RrsigData,
  records: RrsetRecord[],
  dnskey: DnskeyInput,
  now = Math.floor(Date.now() / 1e3),
): Promise<boolean> {
  if (now < rrsig.inception || now > rrsig.expiration) return false;
  if (dnskeyKeyTag(dnskey.rawData) !== rrsig.keyTag) return false;
  const keyData = dnskeyPublicData(dnskey.rawData);
  if (keyData.algorithm !== rrsig.algorithm) return false;
  if (rrsig.algorithm === 15 && rrsig.signature.byteLength !== 64) return false;
  const signer = normalizeDnsName(dnskey.name);
  const rrsigSigner = normalizeDnsName(rrsig.signerName);
  if (signer.toLowerCase() !== rrsigSigner.toLowerCase()) return false;
  try {
    const imported = await importDnskey(dnskey.rawData);
    return await crypto.subtle.verify(
      imported.verifyAlgorithm,
      imported.key,
      rrsig.signature,
      rrsigSignedData(rrsig, records),
    );
  } catch {
    return false;
  }
}
function isRrsigData(data: unknown): data is RrsigData {
  return (
    data !== null &&
    typeof data === 'object' &&
    'typeCovered' in data &&
    'algorithm' in data &&
    'signature' in data
  );
}
function sameName(a: string, b: string): boolean {
  const na = normalizeDnsName(a);
  const nb = normalizeDnsName(b);
  return na.toLowerCase() === nb.toLowerCase();
}
function normalizeDnsName(name: string): string {
  const withoutRootDot = name.endsWith('.') ? name.slice(0, -1) : name;
  return withoutRootDot.length === 0 ? '.' : withoutRootDot;
}
function normalizedLowerName(name: string): string {
  return normalizeDnsName(name).toLowerCase();
}
function findTrustKeysForSigner(trustAnchors: DnskeyInput[], signerName: string): DnskeyInput[] {
  return trustAnchors.filter((key) => sameName(key.name, signerName));
}
/**
 * Validate a response's answer RRset against an already-trusted DNSKEY set.
 *
 * This is the leaf validator the resolver runs once it has authenticated the
 * signing zone's keys through a chain of trust. It selects the answer records
 * matching `qname` and `qtype`, gathers the RRSIGs covering that type, and
 * returns successfully as soon as one RRSIG verifies under a trust anchor whose
 * name matches the signer. It handles only positive answers (`rcode` 0) with
 * signed data present; authenticated denial-of-existence is out of scope here
 * and belongs to `validateDnssecResponse`.
 *
 * Rejects with an `EDNSSEC`-coded error when the response carries a non-zero
 * rcode, the answer RRset is missing, no covering RRSIG is present, or no RRSIG
 * verifies against the supplied trust anchors.
 *
 * ```ts no_run
 * import { validateSignedResponse } from 'internal:net/dnssec';
 *
 * // `zoneKeys` are DNSKEYs already authenticated for the signer.
 * await validateSignedResponse(response, 'example.com', 1, {
 *   trustAnchors: zoneKeys,
 * });
 * ```
 */
export async function validateSignedResponse(
  response: DnssecResponse,
  qname: string,
  qtype: number,
  options: ValidationOptions,
): Promise<void> {
  if (response.rcode !== 0)
    throw dnssecError('DNSSEC denial validation is not available for this response');
  const rrset = response.answers.filter(
    (record) => record.type === qtype && sameName(record.name, qname),
  );
  if (rrset.length === 0) throw dnssecError('missing signed answer RRset');
  const signatures = response.answers
    .filter(
      (record) =>
        record.type === 46 && sameName(record.name, rrset[0]!.name) && isRrsigData(record.data),
    )
    .map((record) => record.data as RrsigData)
    .filter((rrsig) => rrsig.typeCovered === qtype);
  if (signatures.length === 0) throw dnssecError('missing RRSIG for answer RRset');
  const now = options.now ?? Math.floor(Date.now() / 1e3);
  for (const rrsig of signatures) {
    for (const key of findTrustKeysForSigner(options.trustAnchors, rrsig.signerName)) {
      if (await verifyRrsig(rrsig, rrset, key, now)) return;
    }
  }
  throw dnssecError('no valid RRSIG for answer RRset');
}
function recordsForType(response: DnssecResponse, name: string, type: number): DnssecRecord[] {
  return [...response.answers, ...response.authorities].filter(
    (record) => record.type === type && sameName(record.name, name),
  );
}
function signaturesFor(response: DnssecResponse, name: string, type: number): RrsigData[] {
  return [...response.answers, ...response.authorities]
    .filter(
      (record) =>
        record.type === QTYPE_RRSIG && sameName(record.name, name) && isRrsigData(record.data),
    )
    .map((record) => record.data as RrsigData)
    .filter((rrsig) => rrsig.typeCovered === type);
}
async function validateRrset(
  response: DnssecResponse,
  name: string,
  type: number,
  trustedKeys: DnskeyInput[],
  now: number,
): Promise<boolean> {
  const rrset = recordsForType(response, name, type);
  if (rrset.length === 0) return false;
  const signatures = signaturesFor(response, rrset[0]!.name, type);
  for (const rrsig of signatures) {
    for (const key of trustedKeys.filter((candidate) =>
      sameName(candidate.name, rrsig.signerName),
    )) {
      if (await verifyRrsig(rrsig, rrset, key, now)) return true;
    }
  }
  return false;
}
function parentZone(name: string): string | null {
  const normalized = name.endsWith('.') ? name.slice(0, -1) : name;
  if (normalized.length === 0) return null;
  const labels = normalized.split('.').filter(Boolean);
  if (labels.length <= 1) return '.';
  return labels.slice(1).join('.');
}
function nameLabels(name: string): string[] {
  const normalized = normalizedLowerName(name);
  return normalized === '.' ? [] : normalized.split('.').filter(Boolean);
}
function ancestorZones(name: string): string[] {
  const labels = nameLabels(name);
  const zones: string[] = [];
  for (let i = 0; i < labels.length; i++) zones.push(labels.slice(i).join('.'));
  zones.push('.');
  return zones;
}
function canonicalNameCompare(a: string, b: string): number {
  return compareBytes(canonicalName(a), canonicalName(b));
}
function nsecCoversName(owner: string, next: string, name: string): boolean {
  const ownerName = normalizedLowerName(owner);
  const nextName = normalizedLowerName(next);
  const target = normalizedLowerName(name);
  if (target === ownerName) return true;
  const ownerToNext = canonicalNameCompare(ownerName, nextName);
  if (ownerToNext < 0) {
    return (
      canonicalNameCompare(ownerName, target) < 0 && canonicalNameCompare(target, nextName) < 0
    );
  }
  if (ownerToNext > 0) {
    return (
      canonicalNameCompare(ownerName, target) < 0 || canonicalNameCompare(target, nextName) < 0
    );
  }
  return target !== ownerName;
}
function nsecTypes(record: DnssecRecord): number[] {
  const data = record.data as
    | {
        types?: number[];
      }
    | undefined;
  return Array.isArray(data?.types) ? data.types : [];
}
function nsec3Data(record: DnssecRecord): {
  hashAlgorithm: number;
  flags: number;
  iterations: number;
  salt: Uint8Array;
  nextHashedOwnerName: Uint8Array;
  types: number[];
} | null {
  const data = record.data as
    | {
        hashAlgorithm?: number;
        flags?: number;
        iterations?: number;
        salt?: Uint8Array;
        nextHashedOwnerName?: Uint8Array;
        types?: number[];
      }
    | undefined;
  if (
    typeof data?.hashAlgorithm !== 'number' ||
    typeof data.flags !== 'number' ||
    typeof data.iterations !== 'number' ||
    !(data.salt instanceof Uint8Array) ||
    !(data.nextHashedOwnerName instanceof Uint8Array) ||
    !Array.isArray(data.types)
  )
    return null;
  return {
    hashAlgorithm: data.hashAlgorithm,
    flags: data.flags,
    iterations: data.iterations,
    salt: data.salt,
    nextHashedOwnerName: data.nextHashedOwnerName,
    types: data.types,
  };
}
function nsecNextName(record: DnssecRecord): string | null {
  const data = record.data as
    | {
        nextDomainName?: string;
      }
    | undefined;
  return typeof data?.nextDomainName === 'string' ? data.nextDomainName : null;
}
function nsecProvesTypeAbsent(record: DnssecRecord, qtype: number): boolean {
  const types = nsecTypes(record);
  return !types.includes(qtype) && !types.includes(QTYPE_CNAME);
}
function typesProveAbsent(types: number[], qtype: number): boolean {
  return !types.includes(qtype) && !types.includes(QTYPE_CNAME);
}
function base32hexDecode(value: string): Uint8Array | null {
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (const char of value.toUpperCase()) {
    const n = BASE32HEX.indexOf(char);
    if (n < 0) return null;
    buffer = (buffer << 5) | n;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
function nsec3OwnerHash(record: DnssecRecord): Uint8Array | null {
  const first = normalizedLowerName(record.name).split('.')[0];
  if (first === undefined || first.length === 0) return null;
  return base32hexDecode(first);
}
function nsec3Zone(record: DnssecRecord): string | null {
  const labels = nameLabels(record.name);
  if (labels.length < 2) return null;
  return labels.slice(1).join('.');
}
async function nsec3HashName(
  name: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  let digest = new Uint8Array(
    await crypto.subtle.digest('SHA-1', concatBytes([canonicalName(name), salt])),
  );
  for (let i = 0; i < iterations; i++) {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-1', concatBytes([digest, salt])));
  }
  return digest;
}
function nsec3CoversHash(
  ownerHash: Uint8Array,
  nextHash: Uint8Array,
  targetHash: Uint8Array,
): boolean {
  if (compareBytes(ownerHash, targetHash) === 0) return true;
  const ownerToNext = compareBytes(ownerHash, nextHash);
  if (ownerToNext < 0)
    return compareBytes(ownerHash, targetHash) < 0 && compareBytes(targetHash, nextHash) < 0;
  if (ownerToNext > 0)
    return compareBytes(ownerHash, targetHash) < 0 || compareBytes(targetHash, nextHash) < 0;
  return compareBytes(ownerHash, targetHash) !== 0;
}
async function nsec3RecordMatchesName(record: DnssecRecord, name: string): Promise<boolean> {
  const data = nsec3Data(record);
  const ownerHash = nsec3OwnerHash(record);
  if (
    data === null ||
    ownerHash === null ||
    data.hashAlgorithm !== 1 ||
    data.iterations > MAX_NSEC3_ITERATIONS
  )
    return false;
  const hashed = await nsec3HashName(name, data.salt, data.iterations);
  return compareBytes(hashed, ownerHash) === 0;
}
async function nsec3RecordCoversName(record: DnssecRecord, name: string): Promise<boolean> {
  const data = nsec3Data(record);
  const ownerHash = nsec3OwnerHash(record);
  if (
    data === null ||
    ownerHash === null ||
    data.hashAlgorithm !== 1 ||
    data.iterations > MAX_NSEC3_ITERATIONS
  )
    return false;
  const hashed = await nsec3HashName(name, data.salt, data.iterations);
  return (
    compareBytes(hashed, ownerHash) !== 0 &&
    nsec3CoversHash(ownerHash, data.nextHashedOwnerName, hashed)
  );
}
function wildcardForClosestEncloser(closestEncloser: string): string {
  return closestEncloser === '.' ? '*' : `*.${closestEncloser}`;
}
function closestEncloserFromProof(qname: string, nsecs: DnssecRecord[]): string | null {
  const labels = nameLabels(qname);
  for (let i = 1; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    if (nsecs.some((nsec) => sameName(nsec.name, candidate))) return candidate;
  }
  return nsecs.some((nsec) => sameName(nsec.name, '.')) ? '.' : null;
}
function nextCloserName(qname: string, closestEncloser: string): string | null {
  const qLabels = nameLabels(qname);
  const ceLabels = nameLabels(closestEncloser);
  if (qLabels.length <= ceLabels.length) return null;
  return qLabels.slice(qLabels.length - ceLabels.length - 1).join('.');
}
function responseHasPositiveRrset(response: DnssecResponse, name: string, type: number): boolean {
  return recordsForType(response, name, type).length > 0;
}
function cacheGet(
  cache: DnssecCache | undefined,
  key: string,
  now: number,
): DnskeyInput[] | null | undefined {
  const entry = cache?.entries.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= now) {
    cache!.entries.delete(key);
    return undefined;
  }
  cache!.entries.delete(key);
  cache!.entries.set(key, entry);
  return entry.value;
}
function cacheSet(
  cache: DnssecCache | undefined,
  key: string,
  value: DnskeyInput[] | null,
  expiresAt: number,
): void {
  if (cache === undefined || expiresAt <= 0) return;
  cache.entries.set(key, {
    value,
    expiresAt,
  });
  const maxEntries = cache.maxEntries ?? 256;
  while (cache.entries.size > maxEntries) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) break;
    cache.entries.delete(oldest);
  }
}
function responseCacheExpiry(response: DnssecResponse, now: number): number {
  let expiresAt = Number.POSITIVE_INFINITY;
  for (const record of [...response.answers, ...response.authorities]) {
    expiresAt = Math.min(expiresAt, now + Math.max(0, record.ttl));
    if (record.type === QTYPE_RRSIG && isRrsigData(record.data)) {
      expiresAt = Math.min(expiresAt, record.data.expiration);
    }
  }
  return Number.isFinite(expiresAt) ? expiresAt : 0;
}
async function hasValidatedDsNegativeProof(
  response: DnssecResponse,
  name: string,
  parentKeys: DnskeyInput[],
  now: number,
): Promise<boolean> {
  const nsecs = await validatedNsecRecords(response, parentKeys, now);
  for (const nsec of nsecs) {
    const next = nsecNextName(nsec);
    if (sameName(nsec.name, name) && !nsecTypes(nsec).includes(QTYPE_DS)) return true;
    if (next !== null && nsecCoversName(nsec.name, next, name)) return true;
  }
  const nsec3s = await validatedNsec3Records(response, parentKeys, now);
  for (const record of nsec3s) {
    const data = nsec3Data(record);
    if (data === null) continue;
    if ((await nsec3RecordMatchesName(record, name)) && !data.types.includes(QTYPE_DS)) return true;
    if ((data.flags & 1) !== 0 && (await nsec3RecordCoversName(record, name))) return true;
  }
  return false;
}
async function validatedNsecRecords(
  response: DnssecResponse,
  keys: DnskeyInput[],
  now: number,
): Promise<DnssecRecord[]> {
  const out: DnssecRecord[] = [];
  const seen = new Set<string>();
  for (const record of [...response.answers, ...response.authorities]) {
    if (record.type !== QTYPE_NSEC) continue;
    const key = normalizedLowerName(record.name);
    if (seen.has(key)) continue;
    seen.add(key);
    if (await validateRrset(response, record.name, QTYPE_NSEC, keys, now)) out.push(record);
  }
  return out;
}
async function validatedNsec3Records(
  response: DnssecResponse,
  keys: DnskeyInput[],
  now: number,
): Promise<DnssecRecord[]> {
  const out: DnssecRecord[] = [];
  const seen = new Set<string>();
  for (const record of [...response.answers, ...response.authorities]) {
    if (record.type !== QTYPE_NSEC3) continue;
    const data = nsec3Data(record);
    if (data === null || data.hashAlgorithm !== 1 || data.iterations > MAX_NSEC3_ITERATIONS)
      continue;
    const ownerHash = nsec3OwnerHash(record);
    if (ownerHash === null || ownerHash.byteLength !== data.nextHashedOwnerName.byteLength)
      continue;
    const key = normalizedLowerName(record.name);
    if (seen.has(key)) continue;
    seen.add(key);
    if (await validateRrset(response, record.name, QTYPE_NSEC3, keys, now)) out.push(record);
  }
  return out;
}
function nsecProvesNodata(nsecs: DnssecRecord[], qname: string, qtype: number): boolean {
  return nsecs.some((nsec) => sameName(nsec.name, qname) && nsecProvesTypeAbsent(nsec, qtype));
}
async function nsec3ProvesNodata(
  nsec3s: DnssecRecord[],
  qname: string,
  qtype: number,
): Promise<boolean> {
  for (const record of nsec3s) {
    const data = nsec3Data(record);
    const zone = nsec3Zone(record);
    const ownerHash = nsec3OwnerHash(record);
    if (data === null || zone === null || ownerHash === null) continue;
    if (data.hashAlgorithm !== 1 || data.iterations > MAX_NSEC3_ITERATIONS) continue;
    const hashed = await nsec3HashName(qname, data.salt, data.iterations);
    if (compareBytes(hashed, ownerHash) === 0 && typesProveAbsent(data.types, qtype)) return true;
  }
  return false;
}
async function nsec3ClosestEncloser(qname: string, nsec3s: DnssecRecord[]): Promise<string | null> {
  const labels = nameLabels(qname);
  for (let i = 1; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    for (const record of nsec3s) {
      if (await nsec3RecordMatchesName(record, candidate)) return candidate;
    }
  }
  for (const record of nsec3s) {
    if (await nsec3RecordMatchesName(record, '.')) return '.';
  }
  return null;
}
async function nsec3ProvesNameError(
  nsec3s: DnssecRecord[],
  qname: string,
  qtype: number,
): Promise<boolean> {
  const closestEncloser = await nsec3ClosestEncloser(qname, nsec3s);
  if (closestEncloser === null) return false;
  const nextCloser = nextCloserName(qname, closestEncloser);
  if (nextCloser === null) return false;
  let nextCloserCovered = false;
  for (const record of nsec3s) {
    if (await nsec3RecordCoversName(record, nextCloser)) {
      nextCloserCovered = true;
      break;
    }
  }
  if (!nextCloserCovered) return false;
  const wildcard = wildcardForClosestEncloser(closestEncloser);
  for (const record of nsec3s) {
    const data = nsec3Data(record);
    if (data === null) continue;
    if ((await nsec3RecordMatchesName(record, wildcard)) && typesProveAbsent(data.types, qtype))
      return true;
  }
  return false;
}
function nsecProvesNameError(nsecs: DnssecRecord[], qname: string, qtype: number): boolean {
  const closestEncloser = closestEncloserFromProof(qname, nsecs);
  if (closestEncloser === null) return false;
  const nextCloser = nextCloserName(qname, closestEncloser);
  if (nextCloser === null) return false;
  const nextCloserCovered = nsecs.some((nsec) => {
    const next = nsecNextName(nsec);
    return (
      next !== null &&
      !sameName(nsec.name, nextCloser) &&
      nsecCoversName(nsec.name, next, nextCloser)
    );
  });
  if (!nextCloserCovered) return false;
  const wildcard = wildcardForClosestEncloser(closestEncloser);
  return nsecs.some((nsec) => {
    if (sameName(nsec.name, wildcard)) return nsecProvesTypeAbsent(nsec, qtype);
    const next = nsecNextName(nsec);
    return next !== null && nsecCoversName(nsec.name, next, wildcard);
  });
}
async function getTrustedKeys(
  zone: string,
  options: ChainValidationOptions,
  cache: Map<string, DnskeyInput[] | null>,
  state: {
    fetches: number;
    depth: number;
  },
): Promise<DnskeyInput[] | null> {
  const now = options.now ?? Math.floor(Date.now() / 1e3);
  const normalizedZone =
    zone === '.' ? '.' : (zone.endsWith('.') ? zone.slice(0, -1) : zone).toLowerCase();
  if (cache.has(normalizedZone)) return cache.get(normalizedZone)!;
  const cacheKey = `trusted:${normalizedZone}`;
  const cached = cacheGet(options.cache, cacheKey, now);
  if (cached !== undefined) {
    cache.set(normalizedZone, cached);
    return cached;
  }
  const directAnchors = options.trustAnchors.filter((key) => sameName(key.name, normalizedZone));
  if (directAnchors.length > 0) {
    if (normalizedZone === '.') {
      try {
        if (state.fetches++ > (options.maxFetches ?? 32))
          throw dnssecError('maximum DNSSEC validation fetches exceeded');
        const rootDnskeyResponse = await options.fetch('.', QTYPE_DNSKEY);
        if (await validateRrset(rootDnskeyResponse, '.', QTYPE_DNSKEY, directAnchors, now)) {
          const rootKeys = recordsForType(rootDnskeyResponse, '.', QTYPE_DNSKEY).map((record) => ({
            name: record.name,
            rawData: record.rawData,
          }));
          if (rootKeys.length > 0) {
            cache.set(normalizedZone, rootKeys);
            cacheSet(
              options.cache,
              cacheKey,
              rootKeys,
              responseCacheExpiry(rootDnskeyResponse, now),
            );
            return rootKeys;
          }
        }
      } catch {}
    }
    cache.set(normalizedZone, directAnchors);
    return directAnchors;
  }
  if (state.depth++ > (options.maxDepth ?? 32))
    throw dnssecError('maximum DNSSEC delegation depth exceeded');
  const parent = parentZone(normalizedZone);
  if (parent === null) {
    cache.set(normalizedZone, null);
    return null;
  }
  const parentKeys = await getTrustedKeys(parent, options, cache, state);
  if (parentKeys === null) {
    cache.set(normalizedZone, null);
    return null;
  }
  if (state.fetches++ > (options.maxFetches ?? 32))
    throw dnssecError('maximum DNSSEC validation fetches exceeded');
  const dsResponse = await fetchForValidation(options, normalizedZone, QTYPE_DS);
  if (responseHasPositiveRrset(dsResponse, normalizedZone, QTYPE_DS)) {
    if (!(await validateRrset(dsResponse, normalizedZone, QTYPE_DS, parentKeys, now))) {
      throw dnssecError(`invalid DS RRset for ${normalizedZone}`);
    }
  } else if (await hasValidatedDsNegativeProof(dsResponse, normalizedZone, parentKeys, now)) {
    cache.set(normalizedZone, null);
    cacheSet(options.cache, cacheKey, null, responseCacheExpiry(dsResponse, now));
    return null;
  } else {
    throw dnssecError(`missing DS denial proof for ${normalizedZone}`);
  }
  if (state.fetches++ > (options.maxFetches ?? 32))
    throw dnssecError('maximum DNSSEC validation fetches exceeded');
  const dnskeyResponse = await fetchForValidation(options, normalizedZone, QTYPE_DNSKEY);
  const dnskeys = recordsForType(dnskeyResponse, normalizedZone, QTYPE_DNSKEY).map((record) => ({
    name: record.name,
    rawData: record.rawData,
  }));
  if (dnskeys.length === 0) throw dnssecError(`missing DNSKEY RRset for ${normalizedZone}`);
  const dsRecords = recordsForType(dsResponse, normalizedZone, QTYPE_DS);
  const matchingKeys: DnskeyInput[] = [];
  for (const key of dnskeys) {
    for (const ds of dsRecords) {
      const data = ds.data as
        | {
            keyTag?: number;
            algorithm?: number;
            digestType?: number;
            digest?: Uint8Array;
          }
        | undefined;
      if (data?.keyTag !== dnskeyKeyTag(key.rawData)) continue;
      if (data.algorithm !== dnskeyPublicData(key.rawData).algorithm) continue;
      if (!(data.digest instanceof Uint8Array) || typeof data.digestType !== 'number') continue;
      const digest = await digestDnskey(normalizedZone, key.rawData, data.digestType);
      if (compareBytes(digest, data.digest) === 0) matchingKeys.push(key);
    }
  }
  if (matchingKeys.length === 0) throw dnssecError(`no DNSKEY matches DS for ${normalizedZone}`);
  if (!(await validateRrset(dnskeyResponse, normalizedZone, QTYPE_DNSKEY, matchingKeys, now))) {
    throw dnssecError(`invalid DNSKEY RRset for ${normalizedZone}`);
  }
  cache.set(normalizedZone, dnskeys);
  cacheSet(
    options.cache,
    cacheKey,
    dnskeys,
    Math.min(responseCacheExpiry(dsResponse, now), responseCacheExpiry(dnskeyResponse, now)),
  );
  return dnskeys;
}
/**
 * Validate a DNS response end to end by building a DNSSEC chain of trust.
 *
 * This is the full validator the resolver drives. Starting from
 * `options.trustAnchors` (typically `ROOT_TRUST_ANCHORS`), it walks the
 * delegation from the root toward the signer, using `options.fetch` to retrieve
 * the DS and DNSKEY RRsets it needs and authenticating each hop before
 * descending. For a positive answer it verifies the RRSIG over the answer (or
 * CNAME) RRset; for an error rcode or an empty answer it verifies an
 * authenticated NSEC/NSEC3 denial-of-existence proof. Intermediate results can
 * be memoized through `options.cache`, and `maxFetches` and `maxDepth` (default
 * 32 each) bound the work performed per validation.
 *
 * If an authenticated DS-negative proof marks a delegation insecure, the
 * function returns without validating the unsigned data beneath it — a provably
 * insecure answer is not an error. It rejects with an `EDNSSEC`-coded error when
 * signed data is bogus, a required RRSIG or denial proof is missing, a DS/DNSKEY
 * link fails, or the fetch/depth limits are exceeded.
 *
 * ```ts no_run
 * import { validateDnssecResponse, ROOT_TRUST_ANCHORS, DnssecCache } from 'internal:net/dnssec';
 *
 * const cache: DnssecCache = { entries: new Map() };
 * await validateDnssecResponse(response, 'example.com', 1, {
 *   trustAnchors: ROOT_TRUST_ANCHORS,
 *   fetch: (name, qtype) => resolver.queryDnssec(name, qtype),
 *   cache,
 * });
 * // resolves → authenticated (secure or provably insecure)
 * // throws EDNSSEC → bogus
 * ```
 */
export async function validateDnssecResponse(
  response: DnssecResponse,
  qname: string,
  qtype: number,
  options: ChainValidationOptions,
): Promise<void> {
  const now = options.now ?? Math.floor(Date.now() / 1e3);
  async function validateDenial(): Promise<void> {
    const signerNames = new Set<string>();
    for (const denial of [...response.authorities, ...response.answers]) {
      if (denial.type !== QTYPE_NSEC && denial.type !== QTYPE_NSEC3) continue;
      for (const sig of signaturesFor(response, denial.name, denial.type))
        signerNames.add(normalizedLowerName(sig.signerName));
    }
    for (const signerName of signerNames) {
      const keys = await getTrustedKeys(signerName, options, cache, {
        fetches: 0,
        depth: 0,
      });
      if (keys === null) return;
      const nsecs = await validatedNsecRecords(response, keys, now);
      if (nsecProvesNodata(nsecs, qname, qtype) || nsecProvesNameError(nsecs, qname, qtype)) return;
      const nsec3s = await validatedNsec3Records(response, keys, now);
      if (
        (await nsec3ProvesNodata(nsec3s, qname, qtype)) ||
        (await nsec3ProvesNameError(nsec3s, qname, qtype))
      )
        return;
    }
    throw dnssecError('missing valid authenticated denial proof');
  }
  const cache = new Map<string, DnskeyInput[] | null>();
  async function hasInsecureAncestor(): Promise<boolean> {
    for (const zone of ancestorZones(qname)) {
      if (zone === '.') continue;
      const keys = await getTrustedKeys(zone, options, cache, {
        fetches: 0,
        depth: 0,
      });
      if (keys === null) return true;
      return false;
    }
    return false;
  }
  if (response.rcode !== 0) {
    await validateDenial();
    return;
  }
  const candidates =
    recordsForType(response, qname, qtype).length > 0
      ? [
          {
            name: qname,
            type: qtype,
          },
        ]
      : recordsForType(response, qname, QTYPE_CNAME).length > 0
        ? [
            {
              name: qname,
              type: QTYPE_CNAME,
            },
          ]
        : [];
  if (candidates.length === 0) {
    await validateDenial();
    return;
  }
  for (const candidate of candidates) {
    const sigs = signaturesFor(response, candidate.name, candidate.type);
    if (sigs.length === 0) {
      if (await hasInsecureAncestor()) return;
      throw dnssecError('missing RRSIG for answer RRset');
    }
    for (const sig of sigs) {
      const keys = await getTrustedKeys(sig.signerName, options, cache, {
        fetches: 0,
        depth: 0,
      });
      if (keys === null) return;
      if (await validateRrset(response, candidate.name, candidate.type, keys, now)) return;
    }
  }
  throw dnssecError('no valid chain for answer RRset');
}
