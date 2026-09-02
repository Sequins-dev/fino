/**
 * RFC 9412 origin normalization and wire-payload helpers.
 *
 * HTTP/3 origin policy is shared by the client authority gate, server
 * advertisement, and nghttp3 settings marshalling. Keeping it here ensures all
 * three layers apply the same HTTPS-only syntax and resource bounds.
 *
 * HTTP/3 ORIGIN extension: https://www.rfc-editor.org/rfc/rfc9412
 *
 * @internal
 */

export const MAX_H3_ORIGINS = 128;
export const MAX_H3_ORIGIN_BYTES = 4096;

/** Parse and return the canonical ASCII serialization of one HTTPS origin. */
export function normalizeH3Origin(input: string | URL): string {
  const url = input instanceof URL ? input : new URL(input);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError(`invalid HTTP/3 origin: ${url.href}`);
  }
  const origin = url.origin;
  if (new TextEncoder().encode(origin).byteLength > MAX_H3_ORIGIN_BYTES) {
    throw new RangeError(`HTTP/3 origin exceeds ${MAX_H3_ORIGIN_BYTES} bytes`);
  }
  return origin;
}

/** Normalize, de-duplicate, and bound a server ORIGIN advertisement. */
export function normalizeH3Origins(origins: Array<string | URL> | undefined): string[] | undefined {
  if (origins === undefined) return undefined;
  if (origins.length > MAX_H3_ORIGINS) {
    throw new RangeError(`HTTP/3 origins cannot contain more than ${MAX_H3_ORIGINS} entries`);
  }
  return [...new Set(origins.map(normalizeH3Origin))];
}

/** Encode normalized origins as RFC 9412 two-byte-length-prefixed entries. */
export function encodeH3OriginList(origins: string[]): Uint8Array {
  const encoded = origins.map((origin) => new TextEncoder().encode(origin));
  const total = encoded.reduce((sum, value) => sum + 2 + value.byteLength, 0);
  const payload = new Uint8Array(total);
  const view = new DataView(payload.buffer);
  let offset = 0;
  for (const value of encoded) {
    view.setUint16(offset, value.byteLength, false);
    offset += 2;
    payload.set(value, offset);
    offset += value.byteLength;
  }
  return payload;
}
