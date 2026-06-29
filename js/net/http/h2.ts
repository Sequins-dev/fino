/**
* net/http/h2 — internal HTTP/2 capability metadata.
*
* Learn more:
* - HTTP/2: https://www.rfc-editor.org/rfc/rfc9113
* - HPACK: https://www.rfc-editor.org/rfc/rfc7541
*
* This module exposes the runtime's nghttp2-backed HTTP/2 availability for
* internal wiring and tests.
* HTTP/2 is selected automatically by the server for prior-knowledge h2c, h2c
* upgrades, and TLS ALPN `h2`, and by `fetch()` when a pooled HTTPS connection
* negotiates `h2`.
*
* Release baseline:
*   - `h2Available`: whether libnghttp2 was found on this system
*   - `h2Version`: library version string, or null if unavailable
*   - h2spec coverage for runnable RFC 7540/7541 sections, with the checked-in
*     allowlist acting as the current conformance baseline
*
* Current limits:
*   - HTTP/2 server push is not exposed and PUSH_PROMISE h2spec cases are
*     outside this release baseline
*   - h2spec section 6.9 is covered by deterministic local flow-control tests
*     because h2spec v2.6 does not emit reliable JUnit for that section
*   - one-shot H2 server/client paths stream bodies through the shared internal
*     HTTP stream queue; the H2 pool still buffers responses for compatibility
*
* The H2 server and client drivers are internal and are wired into
* `fino:net/http/server`, `fino:net/http/client`, and global `fetch`
* automatically. Applications should select HTTP/2 through those public
* abstractions rather than importing this helper.
*
* @example
* ```ts no_run
* import { h2Available, h2Version } from '../../js/net/http/h2.ts';
*
* if (h2Available) {
*   console.log(`HTTP/2 available through nghttp2 ${h2Version ?? 'unknown'}`);
* }
* ```
*
* @internal
*/
import { h2Available as _h2Available, sym, readCStr, Pointer } from '../../internal/net/http/h2/bindings.ts';
/** `true` when libnghttp2 was loaded successfully.
*
* HTTP/2 server and client paths are only selected automatically when this is
* true. If false, applications should fall back to HTTP/1.1 behavior.
*
* @internal
*/
export const h2Available: boolean = _h2Available;
/** Loaded libnghttp2 version string, or `null` when HTTP/2 is unavailable.
*
* The string comes from `nghttp2_version()` and may be `null` when bindings are
* unavailable or version lookup fails.
*
* @internal
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
  } catch {
    return null;
  }
})();
