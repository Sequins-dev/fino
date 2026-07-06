/**
* internal:net/http/h2 — HTTP/2 (nghttp2) capability metadata.
*
* This module exposes the runtime's nghttp2-backed HTTP/2 availability so that
* internal wiring and tests can branch on whether the platform supports the
* protocol. It carries no request/response logic itself; the actual H2 server
* and client drivers live in `internal:net/http/h2/server` and
* `internal:net/http/h2/client` and are selected automatically.
*
* HTTP/2 is chosen by the server for prior-knowledge h2c, h2c upgrades, and TLS
* ALPN `h2`, and by `fetch()` when a pooled HTTPS connection negotiates `h2`.
* Because selection is automatic, applications should reach for HTTP/2 through
* the public `fino:net/http/server`, `fino:net/http/client`, and global `fetch`
* abstractions rather than importing this helper directly.
*
* The two exports form the release baseline signals: `h2Available` reports
* whether libnghttp2 was found on this system, and `h2Version` gives the loaded
* library version string (or `null` when unavailable). Conformance is tracked
* separately via h2spec coverage of runnable RFC 7540/7541 sections, with the
* checked-in allowlist acting as the current baseline.
*
* Current limits worth knowing: HTTP/2 server push is not exposed and
* PUSH_PROMISE h2spec cases are outside this baseline; h2spec section 6.9 is
* covered by deterministic local flow-control tests because h2spec v2.6 does
* not emit reliable JUnit for that section; and while one-shot H2 server/client
* paths stream bodies through the shared internal HTTP stream queue, the H2
* pool still buffers responses for compatibility.
*
* ```ts no_run
* import { h2Available, h2Version } from 'internal:net/http/h2';
*
* if (h2Available) {
*   console.log(`HTTP/2 available through nghttp2 ${h2Version ?? 'unknown'}`);
* } else {
*   console.log('nghttp2 not found; connections fall back to HTTP/1.1');
* }
* ```
*
* Learn more:
* - HTTP/2: https://www.rfc-editor.org/rfc/rfc9113
* - HPACK: https://www.rfc-editor.org/rfc/rfc7541
*
* @internal
*/
import { h2Available as _h2Available, sym, readCStr, Pointer } from '../../internal/net/http/h2/bindings.ts';
/** `true` when libnghttp2 was loaded successfully at startup.
*
* HTTP/2 server and client paths are only selected automatically when this is
* `true`. When `false`, ALPN offers and h2c upgrades are skipped and every
* connection stays on HTTP/1.1, so callers gating optional H2 behavior should
* branch on this flag first.
*
* ```ts no_run
* import { h2Available } from 'internal:net/http/h2';
*
* const alpn = h2Available ? ['h2', 'http/1.1'] : ['http/1.1'];
* ```
*
* @internal
*/
export const h2Available: boolean = _h2Available;
/** Loaded libnghttp2 version string, or `null` when HTTP/2 is unavailable.
*
* The value is read once at module load from the `nghttp2_info` struct returned
* by `nghttp2_version()`. It is `null` whenever `h2Available` is `false`, and
* also stays `null` if the bindings are missing or the version pointer read
* fails, so treat a `null` result as "version unknown" rather than assuming H2
* is absent — check `h2Available` for that.
*
* ```ts no_run
* import { h2Available, h2Version } from 'internal:net/http/h2';
*
* console.log(h2Available ? `nghttp2 ${h2Version ?? 'unknown'}` : 'no HTTP/2');
* ```
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
