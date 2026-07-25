/**
* internal:ui/web/client — the browser-side runtime for server-driven UI, plus its content hash.
*
* This module is a build-time artifact rather than a live API: it holds the
* complete JavaScript that `fino:ui/web` ships to the browser, baked into the
* binary as a string. The server never runs this code; it serves it verbatim
* at a content-addressed path so the DOM can be steered from the server over
* Server-Sent Events.
*
* The embedded runtime does three things once loaded. It installs a global
* `submit` listener that intercepts any `<form>` carrying a `data-fi-action`
* attribute, sends its `FormData` with an `Accept: text/event-stream` header,
* and streams the SSE response through a patch applier. It applies incoming
* patches by element id in four modes — `inner` (replace innerHTML), `append`
* (insert at the end), `remove` (detach the node), and the default `outer`
* (swap the element for the first child of the new markup) — and also handles
* `state`, `title`, and `navigate` events. Finally, if any element carries a
* `data-fi-view` attribute it opens a long-lived `EventSource` to
* `/_fino/live` so the server can push patches and navigations without a form
* round-trip.
*
* Consumers should not parse or mutate the source; import the two exported
* constants and serve them. `CLIENT_SOURCE` is the script body and
* `CLIENT_HASH` is a stable fingerprint used to build an immutable,
* cache-bustable URL. `fino:ui/web` wires both into its middleware; reach for
* this module directly only when embedding the runtime into a custom handler.
*
* ```ts no_run
*   import { CLIENT_SOURCE, CLIENT_HASH } from 'internal:ui/web/client';
*
*   const path = `/_fino/client.${CLIENT_HASH}.js`;
*
*   // Serve the runtime at its content-addressed path with a far-future cache.
*   function handle(url: URL): Response | undefined {
*     if (url.pathname !== path) return undefined;
*     return new Response(CLIENT_SOURCE, {
*       headers: {
*         'content-type': 'text/javascript; charset=utf-8',
*         'cache-control': 'public, max-age=31536000, immutable'
*       }
*     });
*   }
*
*   // Reference the same path from a page so the browser loads the runtime.
*   const scriptTag = `<script src="${path}"></script>`;
* ```
*
* @internal
*/
const source = `
const state = Object.create(null);
function applyPatch(data) {
  const target = document.getElementById(data.id);
  if (!target && data.mode !== 'append') return;
  if (data.mode === 'remove') {
    target?.remove();
    return;
  }
  if (data.mode === 'inner') {
    target.innerHTML = data.html || '';
    return;
  }
  if (data.mode === 'append') {
    target?.insertAdjacentHTML('beforeend', data.html || '');
    return;
  }
  if (target) {
    const template = document.createElement('template');
    template.innerHTML = data.html || '';
    const next = template.content.firstElementChild;
    if (next) target.replaceWith(next);
  }
}
async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\\n\\n')) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let event = 'message';
      const data = [];
      for (const line of frame.split(/\\r?\\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (event === 'patch') applyPatch(JSON.parse(data.join('\\n')));
      else if (event === 'state') Object.assign(state, JSON.parse(data.join('\\n')));
      else if (event === 'title') document.title = JSON.parse(data.join('\\n'));
      else if (event === 'navigate') {
        const next = JSON.parse(data.join('\\n'));
        if (next.replace) location.replace(next.url);
        else location.href = next.url;
      }
    }
  }
}
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.fiAction) return;
  event.preventDefault();
  fetch(form.action, {
    method: form.method || 'POST',
    body: new FormData(form),
    headers: { accept: 'text/event-stream' },
    credentials: 'same-origin'
  }).then(readSse);
});
function connectLive() {
  const views = Array.from(document.querySelectorAll('[data-fi-view]')).map((el) => el.id).filter(Boolean);
  if (views.length === 0) return;
  const source = new EventSource('/_fino/live?view=' + encodeURIComponent(views.join(',')));
  source.addEventListener('patch', (event) => applyPatch(JSON.parse(event.data)));
  source.addEventListener('navigate', (event) => {
    const next = JSON.parse(event.data);
    if (next.replace) location.replace(next.url);
    else location.href = next.url;
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connectLive);
else connectLive();
`;

function hash(value: string): string {
  let out = 2166136261;
  for (let i = 0; i < value.length; i++) {
    out ^= value.charCodeAt(i);
    out = Math.imul(out, 16777619);
  }
  return (out >>> 0).toString(16);
}

/**
* The complete browser-side runtime script that `fino:ui/web` serves to clients.
*
* This is the embedded source trimmed of surrounding whitespace and terminated
* with a single trailing newline, ready to be sent as a `text/javascript`
* response body. The script is self-initializing: once the browser evaluates
* it, it registers the form-submission interceptor immediately and opens the
* live `EventSource` connection either right away or on `DOMContentLoaded` if
* the document is still parsing. Serve it with a long, immutable cache — the
* body only changes when the runtime itself is rebuilt, and `CLIENT_HASH`
* changes in lockstep to invalidate the old URL.
*
* ```ts no_run
*   import { CLIENT_SOURCE } from 'internal:ui/web/client';
*
*   const response = new Response(CLIENT_SOURCE, {
*     headers: { 'content-type': 'text/javascript; charset=utf-8' }
*   });
* ```
*/
export const CLIENT_SOURCE = source.trim() + '\n';
/**
* A stable fingerprint of `CLIENT_SOURCE`, used to build a cache-bustable URL.
*
* The value is a 32-bit FNV-1a hash of the served script rendered as lowercase
* hexadecimal (up to eight characters). Because it is derived directly from
* `CLIENT_SOURCE`, it stays identical for byte-identical runtimes and changes
* whenever the runtime is rebuilt, which lets the serving path
* (`/_fino/client.<hash>.js`) be marked `immutable` while still updating when
* the code changes. It is a cache key, not a cryptographic digest; do not rely
* on it for integrity or security decisions.
*
* ```ts no_run
*   import { CLIENT_HASH } from 'internal:ui/web/client';
*
*   const scriptPath = `/_fino/client.${CLIENT_HASH}.js`;
* ```
*/
export const CLIENT_HASH = hash(CLIENT_SOURCE);
