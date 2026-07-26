/**
 * Executable MDX compiler and loader coverage.
 */
import { describe, it } from 'fino:test/test';
import { renderToHtml } from 'fino:ui/html';
describe('fino:format/mdx', () => {
  it('compiles MDX into an executable Fino UI module', async (t) => {
    const module = await import('./fixtures/slides-deck.mdx');
    const html = renderToHtml(module.default({ name: 'Fino' }));
    t.equal(module.meta.title, 'A small deck', 'ESM exports are preserved');
    t.ok(html.includes('<h1>Hello, Fino</h1>'), 'Markdown and expressions render');
    t.ok(html.includes('<strong>strong</strong>'), 'inline Markdown renders');
    t.ok(
      html.includes('<aside data-tone="warm">Custom component</aside>'),
      'imported JSX components render',
    );
    t.equal(
      (html.match(/data-fino-slide/g) ?? []).length,
      2,
      'top-level thematic breaks split slides',
    );
    t.ok(html.includes('<li>one</li>'), 'GFM-compatible block content renders');
    t.ok(
      html.includes('<table>') && html.includes('<del>draft</del>'),
      'GFM tables and strikethrough render',
    );
    t.ok(
      html.includes('type="checkbox" checked disabled'),
      'GFM task items render through component mappings',
    );
    const mapped = renderToHtml(
      module.default({
        name: 'Fino',
        components: {
          h1: (props: any) => ({
            type: 'header',
            props: { 'data-mapped': true },
            children: props.children,
            key: null,
          }),
        },
      }),
    );
    t.ok(
      mapped.includes('<header data-mapped>Hello, Fino</header>'),
      'Markdown elements can be overridden with Fino components',
    );
  });
  it('probes the .mdx extension', async (t) => {
    const module = await import('./fixtures/slides-deck');
    t.equal(typeof module.default, 'function', 'extensionless import resolves MDX');
  });
  it('returns positioned diagnostics for malformed MDX', async (t) => {
    const { compileMdx } = await import('fino:format/mdx');
    const result = compileMdx('# Fine\n\n<Component>\n', { filename: 'broken.mdx' });
    t.equal(result.ok, false, 'malformed MDX does not compile');
    t.ok(result.diagnostics.length > 0, 'compiler reports a diagnostic');
    t.equal(result.diagnostics[0]!.line, 3, 'diagnostic points at the original source line');
  });
});
