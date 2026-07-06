/**
* internal:net/http/h3/body-queue — HTTP/3 body queue compatibility alias.
*
* Re-exports the protocol-neutral `HttpBodyQueue` from
* `internal:net/http/stream` under the historical name `H3BodyQueue`. The H3
* server and client drivers once owned a bespoke body queue; that logic has
* since merged into the shared stream primitives so HTTP/2 and HTTP/3 present
* an identical bounded, back-pressured byte stream to application code. This
* module keeps the old specifier and name working for the H3 drivers that
* still import `H3BodyQueue` while that convergence settles, and adds no
* behavior of its own.
*
* `H3BodyQueue` is therefore exactly `HttpBodyQueue`: a bounded async byte
* queue whose producer side is synchronous — so native QPACK/nghttp3 callbacks
* can decide immediately whether a stream overran its local buffering budget —
* and whose consumer side is a normal async iterator. Prefer importing
* `HttpBodyQueue` directly from `internal:net/http/stream` in new code; reach
* for this alias only when touching H3 driver code that already uses the name.
*
* ```ts no_run
* import { H3BodyQueue } from 'internal:net/http/h3/body-queue';
*
* // The H3 driver builds one queue per request/response stream and pushes
* // decoded DATA frames into it as they arrive.
* const body = new H3BodyQueue();
* body.push(new Uint8Array([104, 105])); // "hi" from a DATA frame
* body.close();                          // FIN observed on the QUIC stream
*
* // Application code consumes it as an ordinary async byte stream.
* let total = 0;
* for await (const chunk of body) total += chunk.byteLength;
* console.log(total); // 2
* ```
*
* @internal
*/
export { HttpBodyQueue as H3BodyQueue } from '../stream.ts';
