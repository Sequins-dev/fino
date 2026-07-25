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
