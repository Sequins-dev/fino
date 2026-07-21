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

async function poll(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
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
      return h(Fragment, null,
        h('section', { 'data-fino-slide': 0 }, h('h1', null, 'First slide')),
        h('section', { 'data-fino-slide': 1 },
          h('h2', null, 'Second slide'),
          h(Steps, null, h('p', null, 'Step one'), h('p', null, 'Step two')),
          h(Notes, null, 'Speaker-only note'))
      );
    }
  };
}

function nonce(html: string): string {
  const match = /data-presentation-nonce="([^"]+)"/.exec(html);
  if (!match) throw new Error('missing presentation nonce');
  return match[1]!;
}

function command(url: string, value: string, token: string, origin = 'http://local'): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      origin,
      'sec-fetch-site': origin === 'http://local' ? 'same-origin' : 'cross-site',
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ command: value, nonce: token }).toString()
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
    t.ok(viewerHtml.includes("replace(/\\/$/,'')"), 'viewer emits an escaped trailing-slash expression');
    t.ok(presenterHtml.includes("replace(/\\/$/,'')"), 'presenter emits an escaped trailing-slash expression');
    t.notOk(viewerHtml.includes('replace(//$/'), 'viewer script is not parsed as a line comment');
    t.notOk(presenterHtml.includes('replace(//$/'), 'presenter script is not parsed as a line comment');
  });

  it('fits one fixed slide canvas into viewer and presenter viewports without layout JavaScript', async (t) => {
    const presentation = new Presentation(deckModule());
    const app = new App();
    app.route('/talk').mount(presentation.viewer());
    app.route('/control').mount(presentation.presenter());
    const viewer = await app.handle(new Request('http://local/talk')) as Response;
    const presenter = await app.handle(new Request('http://local/control')) as Response;
    const viewerHtml = await viewer.text();
    const presenterHtml = await presenter.text();
    t.ok(viewerHtml.includes('class="fino-slide-viewport fino-audience"'), 'viewer wraps the fixed canvas in a fitting viewport');
    t.ok(presenterHtml.includes('class="fino-presenter-preview fino-slide-viewport"'), 'presenter current slide uses the same fitting viewport');
    t.ok(presenterHtml.includes('class="fino-next-viewport fino-slide-viewport"'), 'presenter next slide uses the same fitting viewport');
    t.ok(viewerHtml.includes('viewBox="0 0 1600 900"'), 'viewer scales the fixed canvas with a native view box');
    t.ok(presenterHtml.match(/viewBox="0 0 1600 900"/g)?.length === 2, 'presenter scales both preview canvases with native view boxes');
    t.ok(presenterHtml.includes('color:var(--slides-ink)'), 'slide foreground does not inherit from the presenter shell');
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
    t.deepEqual(presentation.state, { slide: 0, step: 0, revision: 5 }, 'reset returns to the beginning and every accepted command has one ordered revision');
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
    const server = app.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const response = await Promise.race([
        fetch(`http://127.0.0.1:${server.port}/talk`),
        loop.timeout(2_000).then(() => { throw new Error('live presentation request timed out'); })
      ]);
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
      const line = await Promise.race([
        proc.stdout.readUntil(new Uint8Array([10]), 4096),
        loop.timeout(2_000).then(() => { throw new Error('slide server startup timed out'); })
      ]);
      if (line === null) throw new Error('slide server exited before reporting its port');
      const port = Number(new TextDecoder().decode(line).trim());
      const response = await Promise.race([
        fetch(`http://127.0.0.1:${port}/talk`, { signal: controller.signal }),
        loop.timeout(2_000).then(() => { throw new Error('standalone slide request timed out'); })
      ]);
      t.ok((await response.text()).includes('Slides that stay together'), 'standalone server responds with compiled MDX');
    } finally {
      controller.abort();
      proc.kill();
      await waiting;
    }
  });
});
