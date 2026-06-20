# dnssec

Internal DNSSEC helpers for `fino:net/dns`.

This module keeps canonical DNS wire encoding and DNSSEC math away from the
resolver transport code. It intentionally has no socket dependencies so the
primitives can be tested with static fixtures.

## DnssecCache

```ts
type DnssecCache = {
  entries: Map<string, {
    value: DnskeyInput[] | null;
    expiresAt: number;
  }>;
  maxEntries?: number;
}
```

## ROOT_TRUST_ANCHORS

```ts
const ROOT_TRUST_ANCHORS: DnskeyInput[]
```

IANA root trust anchors fetched from
https://data.iana.org/root-anchors/root-anchors.xml on 2026-06-19.

## canonicalName

```ts
function canonicalName(name: string): Uint8Array
```

Encode a domain name in DNSSEC canonical wire format.

DNSSEC canonical form lowercases ASCII owner labels and strips a trailing
presentation root dot before producing normal length-prefixed DNS wire
labels. IDNA conversion is intentionally out of scope for this helper.

## dnskeyKeyTag

```ts
function dnskeyKeyTag(dnskeyRdata: Uint8Array): number
```

Return the RFC 4034 appendix B DNSKEY key tag for DNSKEY RDATA.

## digestDnskey

```ts
async function digestDnskey(
  ownerName: string,
  dnskeyRdata: Uint8Array,
  digestType: number
): Promise<Uint8Array>
```

Calculate a DS digest from owner name and DNSKEY RDATA.

Digest type `1` is SHA-1 for legacy validation, `2` is SHA-256, and `4` is
SHA-384. Other digest types are intentionally unsupported.

## canonicalRrsetData

```ts
function canonicalRrsetData(records: RrsetRecord[], rrsig: RrsigTiming): Uint8Array
```

Serialize an RRset in DNSSEC canonical order for RRSIG verification.

Each RR is encoded as owner name, type, class IN, RRSIG original TTL,
RDLENGTH, and exact RDATA. The returned data does not include the RRSIG
metadata prefix; callers prepend that when verifying a signature.

## nsecCoversType

```ts
function nsecCoversType(types: number[], type: number): boolean
```

Check whether a decoded NSEC/NSEC3 type bitmap includes a record type.

## rrsigSignedData

```ts
function rrsigSignedData(rrsig: RrsigData, records: RrsetRecord[]): Uint8Array
```

Build the exact signed data covered by an RRSIG.

## verifyRrsig

```ts
async function verifyRrsig(
  rrsig: RrsigData,
  records: RrsetRecord[],
  dnskey: DnskeyInput,
  now = Math.floor(
    Date.now(
    ) / 1e3
  )
): Promise<boolean>
```

Verify one RRSIG over an RRset with one DNSKEY.

## validateSignedResponse

```ts
async function validateSignedResponse(
  response: DnssecResponse,
  qname: string,
  qtype: number,
  options: ValidationOptions
): Promise<void>
```

Validate signed answer RRsets in a response with an already trusted DNSKEY.

This is the core signed-RRset validator used by the resolver after it has
built a chain of trust. It rejects bogus or indeterminate signed data with
`EDNSSEC`.

## validateDnssecResponse

```ts
async function validateDnssecResponse(
  response: DnssecResponse,
  qname: string,
  qtype: number,
  options: ChainValidationOptions
): Promise<void>
```

Validate a DNS response by building a DNSSEC chain from trust anchors.

If an authenticated DS-negative proof marks a child delegation insecure,
this function returns without validating lower unsigned data. Bogus or
indeterminate signed data rejects with `EDNSSEC`.
