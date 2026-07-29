# Production server-driven UI

`fino:ui/web` is installed as an application layer. A production application
normally composes cookie parsing, HTTP sessions, a durable view store, and the
UI layer in that order:

```ts no_run
import { memoryCache } from 'fino:cache';
import { App, cookies, sessions } from 'fino:net/http/app';
import { transpileFiles } from 'fino:format/typescript';
import { clientScriptPath, page, webUI } from 'fino:ui/web';
import { DatabaseViewStore } from 'fino:ui/web/state';

const views = await DatabaseViewStore.open('sqlite://var/app/ui.db');
const app = new App();
const routes = app
  .value('cookies', cookies())
  .value('session', sessions({
    store: memoryCache({ namespace: 'sessions' }),
    keys: [{ id: 'current', secret: process.env.SESSION_SECRET! }],
    ttlMs: 24 * 60 * 60 * 1000,
  }))
  .layer(webUI({
    store: views,
    secret: process.env.UI_CSRF_SECRET!,
    ttlMs: 24 * 60 * 60 * 1000,
  }));

routes.layer(transpileFiles('./client', { prefix: '/client/' }));
```

Use a shared cache or database session store when requests can reach more than
one process. Keep the session key and UI CSRF secret distinct, rotate session
keys by retaining old verification keys, and never use source-code defaults in
production.

Every page that wants browser enhancement must load the content-addressed
client:

```ts no_run
import { h } from 'fino:ui';
import { clientScriptPath, page } from 'fino:ui/web';

routes.get('/').handle(page((ctx) =>
  h('html', null,
    h('body', null, dashboard.mount(ctx)),
    h('script', { src: clientScriptPath(), defer: true }),
  )
));
```

Forms remain ordinary POST forms. Without JavaScript they use
POST-redirect-GET; with the client they receive SSE patches. The long-lived
`/_fino/live` connection carries checkpoint and cross-tab updates. This is
deliberately SSE plus form actions: it preserves normal HTTP semantics,
browser reconnect support, CSRF handling, and useful no-JavaScript behavior.
Add WebSockets only if a future feature requires bidirectional messages that
cannot be represented as form actions.

Long-running actions can call and await `checkpoint()` after changing their
signals. Each checkpoint is compare-and-swap persisted and published to live
tabs:

```ts no_run
actions: {
  run: {
    async handler({ state, checkpoint }) {
      for await (const chunk of work()) {
        state.output.set((text) => text + chunk);
        await checkpoint();
      }
    },
  },
}
```

`webUI()` sweeps expired snapshots at most once per minute by default. Set
`sweepIntervalMs: false` when an external scheduler owns cleanup. Observe
`fino:ui/sweep` for deletion counts and durations and
`fino:ui/sweep:error` for failures. Cancelling an SSE response disposes its
topic subscriptions.

Configure `historyLimit` on the shared view store to bound retained reconnect
history, and sample `store.stats()` for current head, history, and expired-head
counts. Count `ViewVersionConflictError` at the action boundary to distinguish
expected stale/CAS contention from provider failures. The in-memory and
database providers run the same conformance suite for cloning, concurrent CAS,
retention, compaction, cleanup, and failure atomicity.

## Lifecycle policy

The following values are starting policies, not hidden framework behavior.
Pass them explicitly so deployments can size and change them intentionally:

| Environment | History per view | View TTL | Sweep cadence |
| --- | ---: | ---: | ---: |
| Production | 32 revisions | 1 hour | At most 1 minute |
| Development | 128 revisions | 24 hours | At most 1 minute |
| Tests and previews | 8 revisions | 10 minutes | Every request or explicit |

Thirty-two production revisions cover ordinary reconnect gaps without retaining
an unbounded copy of every checkpoint. High-frequency streaming views should
use 8–16 revisions and persist durable output in domain/workflow storage;
raising UI history is not a durability mechanism. Development keeps more
history for inspection but still has a finite bound.

Estimate retained bytes as:

```text
active views × average encoded snapshot bytes × (1 head + history limit)
```

Include database indexes and serialization overhead when setting alerts. Track
`store.stats()`, encoded snapshot size, `ViewVersionConflictError` rate,
`fino:ui/sweep` duration/deletion counts, and `fino:ui/sweep:error`. Alert on
continued history growth at a stable head count, expired heads surviving two
sweep intervals, or conflict rates that rise independently of user activity.

Expiration deletes the head and all retained history atomically. A missing or
expired head is not recreated from history; the client remounts from application
state. Multi-process deployments should run one scheduled sweeper against the
shared provider and set `sweepIntervalMs: false` on request handlers.

### Protocol and component migration

- Breaking session or SSE changes increment the protocol version. Servers
  support the current and immediately previous version for at least one minor
  release and 90 days after the successor reaches production.
- Breaking component contracts use a new namespaced component version. Keep the
  previous component version for the same 90-day minimum, then retire it only
  after capability telemetry shows no use for 14 consecutive days.
- Additive optional fields may remain within a version only when older readers
  already ignore them and the default preserves existing meaning.
- A schema fingerprint change under the same component version is a release
  defect, not a migration. Use a new version or restore the original schema.
- Declared semantic fallbacks may bridge a missing component implementation.
  Never send executable renderer code or silently reinterpret unknown props.

The 90-day window is a minimum compatibility promise, not an automatic deletion
date. Offline or enterprise clients may require a longer product-specific
window. Retirement removes support only after telemetry and release notes make
the impact explicit.

### Resync, fallback, or reject

| Condition | Required response |
| --- | --- |
| Client revision is behind but retained | Replay ordered missing revisions |
| Revision is older than retained history | Send one full current snapshot |
| Client lost its local tree or requests resync | Send one full current snapshot |
| Snapshot expired or session ownership changed | Reject/remount; do not revive history |
| Supported protocol but capability set changed | Renegotiate and send a full snapshot |
| Component unavailable with declared fallback | Use fallback and report downgrade |
| Component/schema unavailable without fallback | Reject with an actionable incompatibility |
| Protocol version unsupported | Reject with upgrade metadata; resync cannot repair it |

A full resync replaces server-owned tree/state at one authoritative revision.
It does not erase client-owned ephemeral state for stable component keys that
still exist. Clients discard buffered deltas older than the resync revision.

### Stale actions and rebase

`stale: 'reject'` remains the default. Use `stale: 'rebase'` only when all of
these are true:

- the operation is commutative or idempotent against any newer state;
- its meaning does not depend on values, ordering, or selection shown at the
  stale revision;
- repeating it cannot duplicate an external side effect;
- authorization and input validation are evaluated again at execution time;
- the request still passes session ownership, nonce/idempotency, and schema
  checks.

Good candidates include adding an item with a globally unique id or setting an
independent preference to an explicit value under a documented last-write-wins
policy. Deletes, index-based edits, payments, approvals, workflow signals,
navigation decisions, and “toggle” operations reject when stale unless the
application supplies stronger idempotency and conflict semantics.

### Embedded, sealed, and client-owned state

- Client-owned ephemeral state—focus, selection, scroll, animation, in-progress
  native controls—stays local and is keyed by stable component identity.
- Plain embedded values are user-editable document/form state. Treat them as
  untrusted input and validate them before use.
- Sealed embedded values are encrypted and authenticated round trips for small
  server-issued values that must travel with the document. Bind important
  meaning to the view/session/revision and reject replay; sealing alone is not
  durable storage or authorization.
- Server-owned UI state belongs in `ViewSnapshot`; domain and workflow state
  belongs in its authoritative application store and invalidates subscribed
  views.

For browser TypeScript, mount `transpileFiles()` under a narrow prefix and
keep server-only source outside that root. It transpiles on request; it is not
a bundler and does not expose npm packages or server credentials to the
browser.

## Troubleshooting

- `page() requires webUI() middleware`: mount the `webUI()` layer before the
  route.
- `403 Forbidden` on actions: preserve both the session and `fi_csrf`
  cookies; check the request `Origin` and `Sec-Fetch-Site`.
- `409 Conflict`: the form used a stale snapshot. Reload it, or mark only
  operations that are safe to replay as `stale: 'rebase'`.
- `410 Gone` or a live `navigate` event: the snapshot expired or cleanup ran;
  render a fresh page.
- No patches: load `clientScriptPath()`, verify `/_fino/live` is not buffered
  by the reverse proxy, and allow `text/event-stream` responses to remain
  open.
