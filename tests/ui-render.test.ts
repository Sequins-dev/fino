import { describe, it } from 'fino:test/test';
import { resolve } from 'fino:file/path';
import { cwd } from 'fino:process';
import { createRoot, createSignal, h, renderStatic, StaticRenderError } from 'fino:ui';
import { htmlSink, rawHtml, renderToHtml } from 'fino:ui/html';
import { PortableValueError, portableSink, toPortable } from 'fino:ui/portable';
import { renderRealm, renderRealmAll } from 'fino:ui/realm';

function fixture(name: string): string {
  return resolve(cwd(), `tests/fixtures/${name}`).toString();
}

describe('fino:ui render programs', () => {
  it('renders once and commits through a sink', (t) => {
    const html = renderStatic(() => h('main', null, 'Ready'), htmlSink());
    t.equal(html, '<main>Ready</main>', 'static render commits one tree');
  });

  it('reads signals during a static render but rejects writes', (t) => {
    const count = createSignal(2);
    t.equal(
      renderStatic(() => h('p', null, `count ${count.get()}`), htmlSink()),
      '<p>count 2</p>',
      'static render reads current signal state',
    );
    t.throws(
      () =>
        renderStatic(() => {
          count.set(3);
          return h('p', null, 'x');
        }, htmlSink()),
      /Cannot set a signal during a static render/,
      'a write during a static pass throws',
    );
    t.ok(new StaticRenderError() instanceof Error, 'StaticRenderError is an Error');
    t.equal(count.get(), 2, 'the rejected write did not land');
  });

  it('does not guard writes outside the static pass', (t) => {
    const count = createSignal(0);
    renderStatic(() => h('p', null, String(count.get())), htmlSink());
    count.set(1);
    t.equal(count.get(), 1, 'writes after the pass are ordinary');
  });

  it('re-renders a live root when a read signal changes', (t) => {
    const name = createSignal('world');
    const seen: string[] = [];
    const root = createRoot(() => h('p', null, `hello ${name.get()}`), htmlSink());
    const stop = root.subscribe((html) => seen.push(html));
    t.equal(root.output, '<p>hello world</p>', 'first pass runs immediately');
    name.set('fino');
    t.equal(root.output, '<p>hello fino</p>', 'output tracks the latest commit');
    t.deepEqual(seen, ['<p>hello fino</p>'], 'subscribers see later commits only');
    stop();
    root.dispose();
    name.set('ignored');
    t.equal(root.output, '<p>hello fino</p>', 'a disposed root stops re-rendering');
  });

  it('disposes the sink when a render program ends', (t) => {
    let disposed = 0;
    const sink = {
      commit: () => 'x',
      dispose: () => {
        disposed++;
      },
    };
    renderStatic(() => h('p', null, 'a'), sink);
    t.equal(disposed, 1, 'static render disposes its sink');
    const root = createRoot(() => h('p', null, 'a'), sink);
    t.equal(disposed, 1, 'a live root holds its sink open');
    root.dispose();
    root.dispose();
    t.equal(disposed, 2, 'dispose is idempotent');
  });
});

describe('fino:ui/portable', () => {
  it('converts a tree to transferable data', (t) => {
    const tree = toPortable(h('button', { disabled: true, count: 2 }, 'Save'));
    t.deepEqual(
      tree,
      {
        type: 'button',
        props: { disabled: true, count: 2 },
        children: ['Save'],
        key: null,
      },
      'portable trees are plain JSON',
    );
    t.equal(JSON.parse(JSON.stringify(tree)).type, 'button', 'portable trees survive JSON');
  });

  it('rejects values that cannot cross a boundary, naming the path', (t) => {
    t.throws(
      () => toPortable(h('div', { onClick: () => {} })),
      /Portable UI values must be JSON data/,
      'function props are rejected',
    );
    t.throws(
      () => toPortable(h('div', { when: new Date(0) })),
      /Portable UI values must be plain objects/,
      'class instances are rejected',
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    t.throws(
      () => toPortable(h('div', { cyclic })),
      /must not be cyclic/,
      'cycles are rejected',
    );
    try {
      toPortable(h('div', { data: { nested: [1, () => {}] } }));
      t.ok(false, 'expected a rejection');
    } catch (error) {
      t.ok(error instanceof PortableValueError, 'throws PortableValueError');
      t.equal(
        (error as PortableValueError).path,
        'tree.props.data.nested[1]',
        'the error names the offending path',
      );
    }
  });

  it('carries pre-rendered markup as an ordinary portable node', (t) => {
    const tree = toPortable(h('div', null, rawHtml('<span>ok</span>')));
    t.deepEqual(
      tree.children[0],
      { type: 'ui:raw', props: { html: '<span>ok</span>' }, children: [], key: null },
      'raw markup is a plain node, not a symbol payload',
    );
    t.equal(
      renderToHtml(JSON.parse(JSON.stringify(h('div', null, rawHtml('<b>hi</b>'))))),
      '<div><b>hi</b></div>',
      'a round-tripped raw node still renders',
    );
  });

  it('commits portable trees through a sink', (t) => {
    const tree = renderStatic(() => h('main', { id: 'root' }, 'Ready'), portableSink());
    t.equal(tree.type, 'main', 'portable sink commits a portable tree');
    t.deepEqual(tree.props, { id: 'root' }, 'props survive the commit');
  });
});

describe('fino:ui/realm', () => {
  it('renders a component in a realm and completes on exit', async (t) => {
    const tree = await renderRealm(fixture('ui-realm-page.tsx'), {
      props: { title: 'Hello' },
    });
    t.equal(
      renderToHtml(tree as never),
      '<main id="page"><h1>Hello</h1></main>',
      'the parent receives the child tree',
    );
  });

  it('resolves with the final revision after async state settles', async (t) => {
    const tree = await renderRealm(fixture('ui-realm-async.tsx'));
    t.equal(
      renderToHtml(tree as never),
      '<main id="page">resolved</main>',
      'realm exit finalizes the last published revision',
    );
  });

  it('renders many prop sets in one realm run', async (t) => {
    const trees = await renderRealmAll(fixture('ui-realm-page.tsx'), {
      items: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
    });
    t.equal(trees.length, 3, 'one tree per item');
    t.deepEqual(
      trees.map((tree) => renderToHtml(tree as never)),
      [
        '<main id="page"><h1>One</h1></main>',
        '<main id="page"><h1>Two</h1></main>',
        '<main id="page"><h1>Three</h1></main>',
      ],
      'trees come back in item order',
    );
  });

  it('merges shared props into every item', async (t) => {
    const trees = await renderRealmAll(fixture('ui-realm-shared.tsx'), {
      shared: { site: 'Fino' },
      items: [{ title: 'One' }, { title: 'Two' }],
    });
    t.deepEqual(
      trees.map((tree) => renderToHtml(tree as never)),
      ['<main>Fino / One</main>', '<main>Fino / Two</main>'],
      'shared props reach every render',
    );
    t.deepEqual(await renderRealmAll(fixture('ui-realm-page.tsx'), { items: [] }), [], 'empty batch');
  });

  it('reports a component failure instead of hanging', async (t) => {
    await t.rejects(
      () => renderRealm(fixture('ui-realm-throws.tsx')),
      /boom/,
      'a throwing component rejects with its message',
    );
  });
});
