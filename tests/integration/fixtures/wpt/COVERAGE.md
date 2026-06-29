# WPT coverage audit

This audit describes the generated Web Platform Test schedule in
`manifest.generated.ts`. That generated file remains the source of truth for
which upstream WPT files Fino runs, skips, or defers. Refresh the category
counts with:

```sh
./target/release/fino tests/integration/fixtures/wpt/coverage-summary.ts
```

The summary command is read-only. The active issue table below omits categories
whose server-applicable WPT files pass and whose remaining skipped files are only
browser-document compatibility differences or helper scripts. It groups skip
reasons into:

- `server-runtime not applicable`: browser document, `window`, navigation, and
  lifecycle tests that do not apply to Fino's server runtime unless Fino chooses
  to claim that browser surface.
- `harness infrastructure gap`: upstream WPT server or host setup, `.sub`
  preprocessing, and missing WPT helper scripts for otherwise relevant APIs.
- `missing runtime global`: Worker, ServiceWorker, Cache API, browser worker
  exposure modeling, and related globals that Fino does not currently install.
- `known conformance debt`: installed or intended web APIs where the skip is a
  real implementation or policy gap.
- `not a test`: standalone WPT helper scripts discovered in the category tree.

## Category summary

| Category | Globals | Runnable / total | Server-runtime not applicable | Harness infrastructure gap | Missing runtime global | Known conformance debt | Not a test | Classification | Next action |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `url` | `URL`, `URLSearchParams` | 17 / 34 | 11 | 0 | 0 | 4 | 2 | known conformance debt | Keep runnable URL WPTs green; resolve URL parser, origin, setter, and WebIDL shape debt before enabling the data-driven URL WPT files. |
| `urlpattern` | `URLPattern` | 5 / 11 | 1 | 0 | 0 | 2 | 3 | known conformance debt | Keep constructor, `hasRegExpGroups`, `generate()`, `compareComponent()`, object/input `baseURL`, `ignoreCase`, wildcard and brace-group canonicalization, simple component percent-encoding, literal hostname canonicalization, invalid literal hostname rejection, empty regexp group rejection, Unicode parameter names, invalid parameter-name rejection, and inherited `baseURL` literal escaping green; implement the remaining tokenizer, URL component canonicalization, and strict constructor validation cases before enabling the skipped data-driven URLPattern WPT files. |
| `encoding` | `TextEncoder`, `TextDecoder` | 34 / 225 | 163 | 2 | 1 | 0 | 25 | deferred | Resume when legacy encodings and stateful decoder behavior are implemented enough for category-level WPT work to be useful. |
| `dom/events` | `Event`, `CustomEvent`, `EventTarget` | 9 / 187 | 162 | 9 | 1 | 0 | 6 | browser-only | Separate pure EventTarget behavior from document event propagation before using these skips as runtime conformance work. |
| `streams` | `ReadableStream`, `WritableStream`, `TransformStream` | 69 / 112 | 23 | 0 | 2 | 4 | 14 | known conformance debt | Keep behavioral stream WPTs green; address Web Streams WebIDL descriptor/brand-check conformance separately from tentative `ReadableStream` owning-transfer semantics. |
| `fetch` | `fetch`, `Headers`, `Request`, `Response` | 53 / 620 | 194 | 265 | 48 | 0 | 60 | harness gap | Highest priority harness expansion: WPT server, `.sub` preprocessing, service-worker helpers, and explicit Cache API or Worker scope decisions. |
| `FileAPI` | `Blob`, `File`, `FormData`, `FileReader`, `FileReaderSync` | 35 / 98 | 33 | 10 | 13 | 0 | 7 | unsupported global | Decide FileReader document and worker exposure goals, then add WPT server and `.sub` support for remaining FileAPI fixtures. |
| `WebCryptoAPI` | `crypto`, `crypto.subtle`, `CryptoKey` | 25 / 181 | 1 | 1 | 0 | 98 | 56 | known conformance debt | Keep the current digest, random, selected generateKey, and serialization WPT subset green; expand broader algorithm and key-format parity in deliberate groups. |
| `html/webappapis/scripting/processing-model-2` | `reportError` | 1 / 74 | 62 | 0 | 3 | 0 | 8 | browser-only | Do not infer `reportError` browser processing-model obligations unless Fino claims window or worker reporting. |
| `html/browsers/the-window-object` | `self` | 0 / 134 | 131 | 1 | 0 | 0 | 2 | browser-only | Leave as a compatibility difference unless Fino chooses to emulate browser `Window` identity and navigation. |
| `webmessaging` | `MessageEvent`, `MessageChannel`, `MessagePort` | 22 / 132 | 85 | 6 | 12 | 0 | 7 | browser-only | Expand server-relevant MessageChannel coverage separately from document and Worker exposure behavior. |
| `eventsource` | `EventSource` | 4 / 62 | 12 | 28 | 2 | 0 | 16 | harness gap | Add WPT server event-stream support before treating EventSource skips as runtime behavior failures. |
| `websockets` | `WebSocket`, `CloseEvent`, `ErrorEvent` | 5 / 225 | 135 | 75 | 9 | 0 | 1 | harness gap | Highest priority after fetch: add WPT websocket server support, then review browser-only and Worker exposure skips. |
| `webtransport` | `WebTransport` | 0 / 26 | 4 | 18 | 4 | 0 | 0 | harness gap | No runnable coverage yet; unblock WPT server and `.sub` support before judging WebTransport conformance. |

## Priority notes

The largest useful conformance unlock is infrastructure, not runtime behavior:
`fetch`, `websockets`, `eventsource`, and `webtransport` are mostly blocked by
WPT server, host, `.sub`, or helper-script support. Those categories should not
be treated as green merely because their skipped files are not currently
runnable.

Unsupported globals are separate product decisions. Cache API, Worker,
ServiceWorker, browser worker exposure modeling, browser document lifecycle,
navigation, implicit cookie jars, and a browser CORS policy engine remain out of
scope for this audit unless Fino intentionally claims those surfaces.

Known conformance debt is intentionally explicit in this snapshot: URL parser,
origin, setter, and WebIDL shape behavior; remaining URLPattern tokenizer edge
cases, URL component-canonicalization cases, and strict constructor validation;
WebCrypto algorithm and key-format parity beyond the current release subset; Web
Streams WebIDL descriptor/brand-check behavior plus tentative owning-transfer
semantics; and the deferred Encoding category.
FileReader and FileReaderSync coverage is mostly blocked on document and worker
exposure modeling, so that work should be scoped before changing runtime
behavior.
