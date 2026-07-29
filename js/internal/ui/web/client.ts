/**
 * internal:ui/web/client — the browser-side runtime for server-driven UI, plus its content hash.
 *
 * This module is a build-time artifact rather than a live API: it holds the
 * complete JavaScript that `fino:ui/web` ships to the browser, baked into the
 * binary as a string. The server never runs this code; it serves it verbatim
 * at a content-addressed path so the DOM can be steered from the server over
 * Server-Sent Events.
 *
 * The embedded runtime installs a client-owned component registry, renders
 * semantic JSON trees into DOM nodes, submits enhanced forms as versioned JSON
 * action envelopes, and consumes the same `ui` SSE event used by other hosts.
 * If any element carries a `data-fi-view` attribute it opens a long-lived
 * `EventSource` to `/_fino/live`; the first event is the current render, followed
 * by later renders or navigation instructions.
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
const htmlTypes = new Set(
  'a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr'.split(' ')
);
const api = globalThis.finoUI || {};
const components = api.components instanceof Map ? api.components : new Map();
api.components = components;
api.register = (name, implementation) => {
  if (typeof name !== 'string' || name === '') throw new TypeError('Component name is required');
  if (typeof implementation !== 'function') throw new TypeError('Component must be a function');
  components.set(name, implementation);
  return () => components.delete(name);
};
globalThis.finoUI = api;

function setHtmlProp(element, name, value) {
  if (name === 'action' && value && typeof value === 'object' && value.url) {
    element.action = value.url;
    element.dataset.fiAction = value.action || '';
    element.__finoAction = value;
    return;
  }
  if (name === 'style' && value && typeof value === 'object') {
    Object.assign(element.style, value);
    return;
  }
  if (name === 'className') name = 'class';
  if (name === 'htmlFor') name = 'for';
  if (value === false || value === null || value === undefined) return;
  if (value === true) {
    element.setAttribute(name, '');
    if (name in element) {
      try { element[name] = true; } catch {}
    }
    return;
  }
  if (typeof value === 'object') {
    throw new TypeError('HTML prop "' + name + '" must be JSON primitive data');
  }
  if (name === 'value' || name === 'checked' || name === 'selected') {
    try { element[name] = value; } catch {}
  }
  element.setAttribute(name, String(value));
}

function renderNode(node) {
  if (typeof node === 'string') return document.createTextNode(node);
  const children = node.children.map(renderNode);
  if (node.type === 'fragment') {
    const fragment = document.createDocumentFragment();
    fragment.append(...children);
    return fragment;
  }
  const implementation = components.get(node.type);
  if (implementation) {
    const rendered = implementation(node.props, children, node);
    if (!rendered || typeof rendered.nodeType !== 'number') {
      throw new TypeError('Component "' + node.type + '" did not return a DOM node');
    }
    return rendered;
  }
  if (!htmlTypes.has(node.type)) {
    throw new Error('No client component registered for "' + node.type + '"');
  }
  const element = document.createElement(node.type);
  for (const [name, value] of Object.entries(node.props)) setHtmlProp(element, name, value);
  element.append(...children);
  return element;
}

function applyUi(data) {
  if (!data || data.version !== 1) return;
  if (data.kind === 'render') {
    const target = document.getElementById(data.viewId);
    if (target) target.replaceChildren(renderNode(data.tree));
  } else if (data.kind === 'navigate') {
    if (data.replace) location.replace(data.url);
    else location.href = data.url;
  } else if (data.kind === 'error') {
    globalThis.dispatchEvent(new CustomEvent('fino-ui-error', { detail: data }));
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
      if (event === 'ui') applyUi(JSON.parse(data.join('\\n')));
    }
  }
}

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.fiAction) return;
  event.preventDefault();
  const fields = new FormData(form);
  const action = form.__finoAction || {
    url: form.action,
    view: fields.get('_view'),
    revision: Number(fields.get('_ver')),
    request: fields.get('_nonce')
  };
  const input = {};
  for (const [name, value] of fields) {
    if (name.startsWith('_') || name.startsWith('$')) continue;
    input[name] = typeof value === 'string' ? value : value.name;
  }
  fetch(action.url, {
    method: form.method || 'POST',
    body: JSON.stringify({
      version: 1,
      view: action.view,
      revision: action.revision,
      request: action.request,
      input
    }),
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json'
    },
    credentials: 'same-origin'
  }).then(readSse);
});

function connectLive() {
  const views = Array.from(document.querySelectorAll('[data-fi-view]')).map((el) => el.id).filter(Boolean);
  if (views.length === 0) return;
  const url = '/_fino/live?view=' + encodeURIComponent(views.join(',')) +
    '&url=' + encodeURIComponent(location.pathname + location.search);
  const source = new EventSource(url);
  source.addEventListener('ui', (event) => applyUi(JSON.parse(event.data)));
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
