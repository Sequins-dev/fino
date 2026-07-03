/**
* Internal browser runtime source for `fino:ui/web`.
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

export const CLIENT_SOURCE = source.trim() + '\n';
export const CLIENT_HASH = hash(CLIENT_SOURCE);
