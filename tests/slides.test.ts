/**
* Shared presentation state, router mounting, and SSE broadcast coverage.
*/
import { describe, it } from 'fino:test/test';
import { App } from 'fino:net/http/app';
import { parseEventStream } from 'fino:net/http/eventstream';
import { Fragment, h } from 'fino:ui';
import { Presentation } from 'fino:ui/slides';
import { DiskFileSystem } from 'fino:file';
import { Process, execPath } from 'fino:process';
import * as loop from 'internal:runtime/loop';
const fs = new DiskFileSystem();
const encoder = new TextEncoder();
async function poll(check: () => Promise<boolean>, timeoutMs = 3e3): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`poll timed out after ${timeoutMs}ms`);
    await loop.timeout(20);
  }
}
function deckModule() {
  return {
    meta: { title: 'Router deck' },
    default(props: any) {
      const Notes = props.components.Notes;
      const Steps = props.components.Steps;
      return h(Fragment, null, h('section', { 'data-fino-slide': 0 }, h('h1', null, 'First slide')), h('section', { 'data-fino-slide': 1 }, h('h2', null, 'Second slide'), h(Steps, null, h('p', null, 'Step one'), h('p', null, 'Step two')), h(Notes, null, 'Speaker-only note')));
    }
  };
}
function nonce(html: string): string {
  const match = /data-presentation-nonce="([^"]+)"/.exec(html);
  if (!match) throw new Error('missing presentation nonce');
  return match[1]!;
}
function viewerSession(html: string): {
  id: string;
  nonce: string;
} {
  const id = /data-fino-viewer-session="([^"]+)"/.exec(html)?.[1];
  const token = /data-fino-viewer-nonce="([^"]+)"/.exec(html)?.[1];
  if (!id || !token) throw new Error('missing independent viewer session');
  return {
    id,
    nonce: token
  };
}
function command(url: string, value: string, token: string, origin = 'http://local'): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      origin,
      'sec-fetch-site': origin === 'http://local' ? 'same-origin' : 'cross-site',
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      command: value,
      nonce: token
    }).toString()
  });
}
function viewerCommand(url: string, value: string, session: {
  id: string;
  nonce: string;
}, origin = 'http://local'): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      origin,
      'sec-fetch-site': origin === 'http://local' ? 'same-origin' : 'cross-site',
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      command: value,
      session: session.id,
      nonce: session.nonce
    }).toString()
  });
}
describe('fino:ui/slides', () => {
  it('mounts viewer and presenter routers wherever the app chooses', async (t) => {
    const presentation = new Presentation(deckModule());
    const app = new App();
    app.route('/talk').mount(presentation.viewer());
    app.route('/private/control').mount(presentation.presenter());
    const viewer = await app.handle(new Request('http://local/talk')) as Response;
    const presenter = await app.handle(new Request('http://local/private/control')) as Response;
    t.ok((await viewer.text()).includes('First slide'), 'viewer renders at its mount point');
    const presenterHtml = await presenter.text();
    t.ok(presenterHtml.includes('Presenter'), 'presenter renders at its independent mount point');
    t.ok(presenterHtml.includes('First slide'), 'presenter previews the shared current slide');
  });
  it('provides a combined router with a relative presenter branch', async (t) => {
    const presentation = new Presentation(deckModule());
    const app = new App();
    app.route('/conference/talk').mount(presentation.router());
    const viewer = await app.handle(new Request('http://local/conference/talk')) as Response;
    const presenter = await app.handle(new Request('http://local/conference/talk/_presenter')) as Response;
    t.ok((await viewer.text()).includes('First slide'), 'combined viewer is relative to the app mount');
    t.ok((await presenter.text()).includes('Presenter'), 'combined presenter uses the documented relative branch');
  });
  it('emits valid client scripts for mounted route endpoints', async (t) => {
    const presentation = new Presentation(deckModule());
    const app = new App();
    app.route('/talk').mount(presentation.viewer());
    app.route('/control').mount(presentation.presenter());
    const viewer = await app.handle(new Request('http://local/talk')) as Response;
    const presenter = await app.handle(new Request('http://local/control')) as Response;
    const viewerHtml = await viewer.text();
    const presenterHtml = await presenter.text();
    t.ok(viewerHtml.includes('replace(/\\/$/,\'\')'), 'viewer emits an escaped trailing-slash expression');
    t.ok(presenterHtml.includes('replace(/\\/$/,\'\')'), 'presenter emits an escaped trailing-slash expression');
    t.notOk(viewerHtml.includes('replace(//$/'), 'viewer script is not parsed as a line comment');
    t.notOk(presenterHtml.includes('replace(//$/'), 'presenter script is not parsed as a line comment');
  });
  it('gives follow=false viewers an isolated server-driven SSE session', async (t) => {
    const presentation = new Presentation(deckModule());
    const app = new App();
    app.route('/talk').mount(presentation.viewer());
    const page = await app.handle(new Request('http://local/talk?follow=false')) as Response;
    const pageHtml = await page.text();
    const session = viewerSession(pageHtml);
    t.ok(pageHtml.includes('First slide'), 'independent viewer starts at the beginning of the deck');
    await presentation.next();
    const response = await app.handle(new Request(`http://local/talk/_events?session=${session.id}`)) as Response;
    const events = parseEventStream(response.body!)[Symbol.asyncIterator]();
    const initial = await events.next();
    t.ok(initial.value?.data.includes('First slide') === true, 'independent stream starts with its own current slide');
    const moved = await app.handle(viewerCommand('http://local/talk/_command', 'next', session)) as Response;
    t.equal(moved.status, 200, 'direction command updates the independent session');
    const update = await events.next();
    t.ok(update.value?.data.includes('Second slide') === true, 'independent stream receives its navigation patch');
    t.deepEqual(presentation.state, {
      slide: 1,
      step: 0,
      revision: 1
    }, 'independent navigation does not mutate presenter state');
    const followed = await app.handle(new Request('http://local/talk')) as Response;
    t.ok((await followed.text()).includes('Second slide'), 'normal audience remains on presenter state');
    const rejected = await app.handle(viewerCommand('http://local/talk/_command', 'next', {
      ...session,
      nonce: 'wrong'
    })) as Response;
    t.equal(rejected.status, 403, 'independent commands require the session nonce');
    await events.return?.();
    await presentation.close();
  });
  it('maps direction keys to an independent viewer session without changing follow mode', async (t) => {
    const presentation = new Presentation(deckModule());
    const app = new App();
    app.route('/talk').mount(presentation.viewer());
    const followed = await app.handle(new Request('http://local/talk')) as Response;
    const independent = await app.handle(new Request('http://local/talk?follow=false')) as Response;
    const followedHtml = await followed.text();
    const independentHtml = await independent.text();
    t.notOk(followedHtml.includes('data-fino-viewer-session'), 'default viewer continues to follow presenter state');
    t.ok(independentHtml.includes('new EventSource(endpoint+\'/_events?session=\'+encodeURIComponent(session))'), 'independent viewer subscribes to its own SSE session');
    t.ok(independentHtml.includes('event.key===\'ArrowRight\'||event.key===\'ArrowDown\''), 'right and down arrows advance');
    t.ok(independentHtml.includes('event.key===\'ArrowLeft\'||event.key===\'ArrowUp\''), 'left and up arrows go back');
    t.ok(independentHtml.includes('send(\'next\')'), 'forward keys send a server navigation command');
    t.ok(independentHtml.includes('send(\'previous\')'), 'back keys send a server navigation command');
    await presentation.close();
  });
  it('bounds retained independent viewer sessions', async (t) => {
    const presentation = new Presentation(deckModule());
    const app = new App();
    app.route('/talk').mount(presentation.viewer());
    const first = await app.handle(new Request('http://local/talk?follow=false')) as Response;
    const oldest = viewerSession(await first.text());
    for (let index = 0; index < 128; index++) {
      await app.handle(new Request('http://local/talk?follow=false'));
    }
    const expired = await app.handle(viewerCommand('http://local/talk/_command', 'next', oldest)) as Response;
    t.equal(expired.status, 404, 'creating a 129th session expires the oldest retained viewer');
    await presentation.close();
  });
  it('fits one responsive slide into viewer and presenter viewports without layout JavaScript', async (t) => {
    const presentation = new Presentation(deckModule());
    const app = new App();
    app.route('/talk').mount(presentation.viewer());
    app.route('/control').mount(presentation.presenter());
    const viewer = await app.handle(new Request('http://local/talk')) as Response;
    const presenter = await app.handle(new Request('http://local/control')) as Response;
    const viewerHtml = await viewer.text();
    const presenterHtml = await presenter.text();
    t.ok(viewerHtml.includes('class="fino-slide-viewport fino-audience"'), 'viewer wraps the responsive slide in a fitting viewport');
    t.ok(presenterHtml.includes('class="fino-presenter-preview fino-slide-viewport"'), 'presenter current slide uses the same fitting viewport');
    t.ok(presenterHtml.includes('class="fino-next-viewport fino-slide-viewport"'), 'presenter next slide uses the same fitting viewport');
    t.ok(viewerHtml.includes('<div class="fino-slide-surface">'), 'viewer renders a responsive HTML slide surface');
    t.ok(presenterHtml.match(/<div class="fino-slide-surface">/g)?.length === 2, 'presenter renders responsive HTML surfaces for both previews');
    t.notOk(viewerHtml.includes('<svg'), 'viewer does not use a fixed SVG canvas');
    t.notOk(presenterHtml.includes('<svg'), 'presenter does not use fixed SVG canvases');
    t.notOk(viewerHtml.includes('1600px'), 'viewer does not retain a fixed design width');
    t.notOk(viewerHtml.includes('900px'), 'viewer does not retain a fixed design height');
    t.ok(viewerHtml.includes('.fino-slide-viewport{position:relative;display:grid;place-items:center;overflow:hidden;container-type:size}'), 'each host exposes both dimensions to its slide');
    t.ok(viewerHtml.includes('.fino-slide-surface{width:min(100cqw,177.7777778cqh);height:min(100cqh,56.25cqw);aspect-ratio:16/9;container-type:inline-size}'), 'slide surface takes the largest contained 16:9 area');
    t.ok(viewerHtml.includes('.fino-slide-frame{position:relative;width:100%;height:100%;'), 'slide content fills its responsive surface');
    t.ok(viewerHtml.includes('font-size:1.25cqw'), 'slide-local content remains legible as the responsive surface scales');
    t.ok(viewerHtml.includes('margin:0;max-width:100%'), 'slide headings can use the full content width');
    t.ok(viewerHtml.includes('.fino-slide-frame h1{font-size:5.5cqw}'), 'slide titles leave more room for supporting content');
    t.ok(viewerHtml.includes('.fino-slide-frame h2{font-size:4.6cqw}'), 'section titles remain prominent without dominating the slide');
    t.ok(viewerHtml.includes('.fino-slide-frame p,.fino-slide-frame li{font-size:2.5cqw'), 'body copy uses a readable presentation scale');
    t.notOk(viewerHtml.includes('background-size:5px 5px'), 'slide decoration does not retain fixed pixel dimensions');
    t.ok(viewerHtml.includes('background-size:.3125em .3125em'), 'slide decoration follows the slide-local scale');
    t.ok(presenterHtml.includes('color:var(--slides-ink)'), 'slide foreground does not inherit from the presenter shell');
    t.ok(viewerHtml.includes('.fino-audience{width:100vw;height:100vh'), 'viewer gives the slide scaler the full browser viewport');
    t.ok(presenterHtml.includes('.fino-presenter-preview{width:100%;height:100%;min-width:0;min-height:0}'), 'presenter current slide fills its allocated preview cell');
    t.ok(presenterHtml.includes('.fino-next-viewport{width:100%;aspect-ratio:16/9}'), 'presenter next slide fills its bounded preview area');
    t.notOk(viewerHtml.includes('.fino-slide-viewport{position:relative;overflow:hidden;aspect-ratio:16/9}'), 'shared viewport does not force a width-driven box around the slide');
    t.ok(viewerHtml.includes('.fino-fullscreen{position:absolute;right:0;top:0;'), 'fullscreen control overlays the slide without reserving space');
    t.ok(viewerHtml.includes('opacity:0;transition:opacity'), 'fullscreen control is hidden until its corner is targeted');
    t.ok(viewerHtml.includes('.fino-fullscreen:hover,.fino-fullscreen:focus-visible{opacity:1}'), 'fullscreen control fades in for pointer and keyboard users');
    t.notOk(viewerHtml.includes('ResizeObserver'), 'viewer needs no JavaScript layout observer');
    t.notOk(presenterHtml.includes('ResizeObserver'), 'presenter needs no JavaScript layout observer');
  });
  it('navigates shared state through same-origin nonce-protected commands', async (t) => {
    const presentation = new Presentation(deckModule());
    const app = new App();
    app.route('/talk').mount(presentation.viewer());
    app.route('/control').mount(presentation.presenter());
    const page = await app.handle(new Request('http://local/control')) as Response;
    const token = nonce(await page.text());
    const rejectedOrigin = await app.handle(command('http://local/control/_command', 'next', token, 'https://evil.example')) as Response;
    const rejectedNonce = await app.handle(command('http://local/control/_command', 'next', 'wrong')) as Response;
    t.equal(rejectedOrigin.status, 403, 'cross-origin command is rejected');
    t.equal(rejectedNonce.status, 403, 'invalid nonce is rejected');
    const moved = await app.handle(command('http://local/control/_command', 'next', token)) as Response;
    const movedBody = await moved.text();
    t.equal(moved.status, 200, `valid presenter command succeeds (${movedBody})`);
    const viewer = await app.handle(new Request('http://local/talk')) as Response;
    t.ok((await viewer.text()).includes('Second slide'), 'viewer observes presenter-controlled state');
  });
  it('broadcasts one ordered patch revision to every viewer', async (t) => {
    const presentation = new Presentation(deckModule());
    const app = new App();
    app.route('/talk').mount(presentation.viewer());
    const first = await app.handle(new Request('http://local/talk/_events')) as Response;
    const second = await app.handle(new Request('http://local/talk/_events')) as Response;
    const a = parseEventStream(first.body!)[Symbol.asyncIterator]();
    const b = parseEventStream(second.body!)[Symbol.asyncIterator]();
    await a.next();
    await b.next();
    await presentation.next();
    const [eventA, eventB] = await Promise.all([a.next(), b.next()]);
    t.equal(eventA.value?.id, eventB.value?.id, 'viewers receive the same revision');
    t.equal(eventA.value?.data, eventB.value?.data, 'viewers receive identical rendered HTML');
    t.ok(eventA.value?.data.includes('Second slide') === true, 'patch contains the new slide');
    await a.return?.();
    await b.return?.();
    await presentation.close();
  });
  it('clamps navigation and reveals steps before advancing', async (t) => {
    const presentation = new Presentation(deckModule());
    await presentation.previous();
    t.equal(presentation.state.slide, 0, 'previous clamps at the first slide');
    await presentation.next();
    t.equal(presentation.state.slide, 1, 'next advances to the second slide');
    t.equal(presentation.state.step, 0, 'new slide starts at its first step');
    await presentation.next();
    t.equal(presentation.state.slide, 1, 'next reveals a remaining step first');
    t.equal(presentation.state.step, 1, 'step advances in place');
    await presentation.next();
    t.equal(presentation.state.slide, 1, 'next clamps at the final slide');
    await presentation.reset();
    t.deepEqual(presentation.state, {
      slide: 0,
      step: 0,
      revision: 5
    }, 'reset returns to the beginning and every accepted command has one ordered revision');
  });
  it('hot-patches file decks and keeps the last good audience on errors', async (t) => {
    const dir = `/tmp/fino-presentation-${crypto.randomUUID()}`;
    const path = `${dir}/deck.mdx`;
    await fs.mkdir(dir);
    await fs.writeFile(path, encoder.encode('# First version'));
    const presentation = new Presentation(path);
    const app = new App();
    app.route('/talk').mount(presentation.viewer());
    app.route('/control').mount(presentation.presenter());
    try {
      const first = await app.handle(new Request('http://local/talk')) as Response;
      t.ok((await first.text()).includes('First version'), 'initial file deck renders');
      await loop.timeout(100);
      await fs.writeFile(path, encoder.encode('# Broken\n\n<Broken>'));
      await poll(async () => {
        const response = await app.handle(new Request('http://local/control')) as Response;
        return (await response.text()).includes('Missing closing JSX tag');
      });
      const retained = await app.handle(new Request('http://local/talk')) as Response;
      t.ok((await retained.text()).includes('First version'), 'invalid edit retains the last valid audience');
      await fs.writeFile(path, encoder.encode('# Second version'));
      await poll(async () => {
        const response = await app.handle(new Request('http://local/talk')) as Response;
        return (await response.text()).includes('Second version');
      });
      t.ok(true, 'valid edit recovers without replacing the application realm');
    } finally {
      await presentation.close();
      await fs.unlink(path);
      await fs.rmdir(dir);
    }
  });
  it('serves a file-backed presentation through a live app server', async (t) => {
    const presentation = new Presentation('./demos/slides.mdx');
    const app = new App();
    app.route('/talk').mount(presentation.viewer());
    const server = app.listen({
      hostname: '127.0.0.1',
      port: 0
    });
    try {
      const response = await Promise.race([fetch(`http://127.0.0.1:${server.port}/talk`), loop.timeout(2e3).then(() => {
        throw new Error('live presentation request timed out');
      })]);
      t.ok((await response.text()).includes('Slides that stay together'), 'live server responds with compiled MDX');
    } finally {
      await server.close();
      await presentation.close();
    }
  });
  it('serves a file deck when presentation loading starts during application startup', async (t) => {
    const fixture = new URL('./fixtures/slides-live-server.ts', import.meta.url).pathname;
    const proc = new Process(execPath, [fixture]);
    proc.stdin.close();
    const waiting = proc.wait();
    const controller = new AbortController();
    try {
      const line = await Promise.race([proc.stdout.readUntil(new Uint8Array([10]), 4096), loop.timeout(2e3).then(() => {
        throw new Error('slide server startup timed out');
      })]);
      if (line === null) throw new Error('slide server exited before reporting its port');
      const port = Number(new TextDecoder().decode(line).trim());
      const response = await Promise.race([fetch(`http://127.0.0.1:${port}/talk`, { signal: controller.signal }), loop.timeout(2e3).then(() => {
        throw new Error('standalone slide request timed out');
      })]);
      t.ok((await response.text()).includes('Slides that stay together'), 'standalone server responds with compiled MDX');
    } finally {
      controller.abort();
      proc.kill();
      await waiting;
    }
  });
});
