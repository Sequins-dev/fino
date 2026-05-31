/**
 * fino:net/http2 — public HTTP/2 module.
 *
 * Currently exposes:
 *   - `h2Available`: whether libnghttp2 was found on this system
 *   - `h2Version`:   library version string, or null if unavailable
 *
 * The H2 server and client drivers are wired into `fino:net/serve` and
 * `fino:fetch` automatically; applications do not import this module unless
 * they need to check library availability.
 */

import { h2Available as _h2Available, sym, readCStr, Pointer } from './http2/bindings.mts';
export { H2ClientDriver } from './http2/client.mts';
export { Nghttp2Session } from './http2/session.mts';
export { createPoolEntry } from '../internal/http-pool.mts';

export const h2Available: boolean = _h2Available;

export const h2Version: string | null = (() => {
  if (!_h2Available || sym === null) return null;
  try {
    // nghttp2_version returns a pointer to nghttp2_info { int age; int version_num; const char* version_str; ... }
    // version_str is at offset 8 (two ints = 8 bytes, then pointer aligned to 8).
    const infoPtr = sym.nghttp2_version(0) as ArrayBuffer | null;
    if (infoPtr === null) return null;
    const strPtr = Pointer.readPointer(infoPtr, 8) as ArrayBuffer | null;
    if (strPtr === null) return null;
    return readCStr(strPtr);
  } catch { return null; }
})();
