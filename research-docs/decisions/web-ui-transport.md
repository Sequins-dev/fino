# Web UI transport: SSE downstream, HTTP actions upstream

Status: Accepted

## Decision

Keep the `fino:ui/web` browser transport intentionally asymmetric:

- ordinary form POSTs or enhanced `fetch()` requests send actions to the server;
- one server-sent events connection delivers patches and navigation events;
- snapshot versions and event IDs recover state after reconnect;
- no-JavaScript POST-redirect-GET remains a supported path.

Do not add a WebSocket patch transport until a concrete product requirement
needs long-lived, unsolicited browser-to-server messages that cannot be
represented as actions.

## Current interaction model

The server is authoritative for view state. A browser submits a named action
with a snapshot version, nonce, embedded state, and CSRF token. The server
loads the durable snapshot, executes the action, compare-and-set persists each
checkpoint, and publishes the new version. Live tabs subscribe to the view
topic and render the latest snapshot as an SSE patch.

This is not a symmetric messaging protocol disguised as HTTP. Browser input is
discrete and transactional; server output is ordered and streaming.

## Comparison

| Concern | SSE plus HTTP actions | WebSocket patches |
| --- | --- | --- |
| Bidirectionality | Separate action requests cover the current discrete input model. | Native duplex messages help only if the browser must continuously push outside an action. |
| Backpressure | Each action has normal HTTP admission, cancellation, status, and retry semantics. Patch streams converge on the latest durable snapshot rather than queueing every intermediate mutation. | Requires an application protocol for admission, acknowledgements, queue limits, and slow-client policy in both directions. |
| Reconnect | Event IDs and durable snapshot versions let a new connection catch up or navigate when state expired. | Requires custom resume tokens, replay rules, and connection-state restoration. |
| Proxies and protocols | Uses an ordinary streaming HTTP response and ordinary requests across supported HTTP versions. Reverse proxies only need buffering disabled for the event stream. | Requires upgrade support; Fino's current client transport is HTTP/1.1-only because extended CONNECT over HTTP/2 and HTTP/3 is not implemented. |
| Security | Action requests reuse origin checks, session cookies, CSRF validation, request limits, and standard audit boundaries. | Every message needs equivalent origin/session/CSRF or capability rules after the upgrade. |
| No-JavaScript behavior | Forms continue to work through POST-redirect-GET. | No equivalent progressive-enhancement path. |
| Operational complexity | One disposable subscription per live tab; abandoned streams release topic handles. | Adds connection registries, heartbeats, duplex flow control, message schemas, and upgrade-specific observability. |

## Backpressure and convergence

The UI does not promise delivery of every transient signal mutation to every
tab. Checkpoints persist monotonic snapshots. A live notification tells a tab
to load and render the latest version, so a slow or reconnecting tab converges
without retaining an unbounded patch queue.

Long-running actions must await `checkpoint()` to preserve durable ordering.
Action admission and request-body backpressure stay on the HTTP request path.

## Conditions for revisiting

Open a new research issue if a real feature requires one or more of:

- continuous high-rate browser input where one request per action is
  demonstrably inadequate;
- a negotiated duplex subprotocol with server acknowledgements;
- browser-originated streaming that must share ordering with server patches;
- latency evidence showing the current request path misses a product target.

Any WebSocket proposal must specify resume semantics, slow-client policy,
message-level authorization, no-JavaScript fallback, HTTP/2 and HTTP/3
behavior, and migration compatibility with the SSE client.

## Consequences

The current SSE client remains the canonical and smallest transport. WebSocket
support elsewhere in Fino remains available to applications, but
`fino:ui/web` does not inherit its complexity without a demonstrated need.
