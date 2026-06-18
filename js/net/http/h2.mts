/**
 * fino:net/http/h2 — public HTTP/2 module.
 *
 * Currently exposes:
 *   - `h2Available`: whether libnghttp2 was found on this system
 *   - `h2Version`:   library version string, or null if unavailable
 *
 * The H2 server and client drivers are wired into `fino:net/http/server` and
 * the global `fetch` implementation automatically; applications do not import this module unless
 * they need to check library availability.
 *
 * @example
 * ```ts no_run
 * import { h2Available, h2Version } from 'fino:net/http/h2';
 *
 * if (h2Available) {
 *   console.log(`HTTP/2 available through nghttp2 ${h2Version ?? 'unknown'}`);
 * }
 * ```
 */

import { h2Available as _h2Available, sym, readCStr, Pointer } from '../../internal/net/http/h2/bindings.mts';
/** HTTP/2 client driver implementation used by the HTTP client pool.
 *
 * ```ts no_run
 * import { H2ClientDriver } from 'fino:net/http/h2';
 * ```
 */
export { H2ClientDriver } from '../../internal/net/http/h2/client.mts';
/** Low-level nghttp2 session wrapper used by HTTP/2 drivers.
 *
 * ```ts no_run
 * import { Nghttp2Session } from 'fino:net/http/h2';
 * ```
 */
export { Nghttp2Session } from '../../internal/net/http/h2/session.mts';
/** Create a pooled HTTP/2 client connection entry.
 *
 * ```ts no_run
 * import { createPoolEntry } from 'fino:net/http/h2';
 * ```
 */
export { createPoolEntry } from '../../internal/net/http/pool.mts';

/** `true` when libnghttp2 was loaded successfully.
 *
 * HTTP/2 server and client paths are only selected automatically when this is
 * true. If false, applications should fall back to HTTP/1.1 behavior.
 *
 * ```ts no_run
 * if (h2Available) console.log('HTTP/2 enabled');
 * ```
 */
export const h2Available: boolean = _h2Available;

/** Loaded libnghttp2 version string, or `null` when HTTP/2 is unavailable.
 *
 * The string comes from `nghttp2_version()` and may be `null` when bindings are
 * unavailable or version lookup fails.
 *
 * ```ts no_run
 * console.log(h2Version ?? 'HTTP/2 unavailable');
 * ```
 */
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
