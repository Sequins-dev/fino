import { describe, it } from 'fino:test/test';
import { parseMarkdown, renderMarkdown, renderMarkdownInline } from 'fino:format/markdown';

describe('fino:format/markdown', () => {
  it('renders common markdown blocks and inline spans', (t) => {
    const html = renderMarkdown(`# Title

Use **bold**, *emphasis*, \`code\`, and [docs](https://example.test).

- one
- two

\`\`\`ts
const value = "<safe>";
\`\`\``, { headingOffset: 2 });

    t.ok(html.includes('<h3>Title</h3>'), 'renders headings with offset');
    t.ok(html.includes('Use <strong>bold</strong>, <em>emphasis</em>, <code>code</code>, and <a href="https://example.test">docs</a>.'), 'renders inline markdown');
    t.ok(html.includes('<ul>\n<li>one</li>\n<li>two</li>\n</ul>'), 'renders unordered lists');
    t.ok(html.includes('<pre><code class="language-ts">const value = &quot;&lt;safe&gt;&quot;'), 'renders escaped fenced code');
  });

  it('renders inline markdown without wrapping blocks', (t) => {
    t.equal(renderMarkdownInline('Return the `value` as **HTML**.'), 'Return the <code>value</code> as <strong>HTML</strong>.');
  });

  it('renders image spans', (t) => {
    t.equal(renderMarkdownInline('![fino logo](./logo.svg)'), '<img src="./logo.svg" alt="fino logo">');
  });

  it('renders reference links and autolinks through the scanner parser', (t) => {
    const doc = parseMarkdown(`See [ResourceBox][box] and https://example.test/docs.

[box]: ./advanced.mts#ResourceBox`);

    const html = renderMarkdown(doc, {
      resolveLink(href) {
        return href === './advanced.mts#ResourceBox' ? 'advanced.html#advanced.ResourceBox' : href;
      },
    });

    t.ok(html.includes('<a href="advanced.html#advanced.ResourceBox">ResourceBox</a>'), 'renders reference link');
    t.ok(html.includes('<a href="https://example.test/docs">https://example.test/docs</a>.'), 'linkifies bare URL without trailing punctuation');
  });

  it('omits unsafe links and image URLs by default', (t) => {
    t.equal(renderMarkdownInline('[run](javascript:alert(1))'), 'run', 'unsafe link renders as label text');
    t.equal(renderMarkdownInline('![logo](javascript:alert(1))'), 'logo', 'unsafe image renders as alt text');
  });

  it('allows unsafe links only when explicitly requested', (t) => {
    t.equal(
      renderMarkdownInline('[run](javascript:alert(1))', { allowUnsafeLinks: true }),
      '<a href="javascript:alert(1)">run</a>',
      'allowUnsafeLinks permits protocol URLs',
    );
    t.equal(
      renderMarkdownInline('![logo](javascript:alert(1))', { allowUnsafeLinks: true }),
      '<img src="javascript:alert(1)" alt="logo">',
      'allowUnsafeLinks permits image URLs',
    );
  });

  it('checks resolved links against the safe-link policy', (t) => {
    const html = renderMarkdownInline('[docs](/docs)', {
      resolveLink() {
        return 'javascript:alert(1)';
      },
    });

    t.equal(html, 'docs', 'unsafe resolved URL is omitted');
  });

  it('escapes raw HTML by default', (t) => {
    const html = renderMarkdown('<script>alert(1)</script>\n\nRaw <b>HTML</b>.');

    t.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'raw block HTML is escaped');
    t.ok(html.includes('Raw &lt;b&gt;HTML&lt;/b&gt;.'), 'raw inline HTML is escaped');
  });

  it('keeps nested lists in the compact flat-list model', (t) => {
    const html = renderMarkdown('- parent\n  - child\n- sibling');

    t.equal(
      html,
      '<ul>\n<li>parent</li>\n<li>child</li>\n<li>sibling</li>\n</ul>',
      'indented nested markers render as flat items',
    );
  });

  it('renders escaped punctuation literally', (t) => {
    t.equal(
      renderMarkdownInline('Use \\*stars\\*, \\[brackets\\], and \\`ticks\\`.'),
      'Use *stars*, [brackets], and `ticks`.',
      'backslash escapes punctuation that would otherwise start inline spans',
    );
  });

  it('renders malformed links as escaped plain text', (t) => {
    t.equal(
      renderMarkdownInline('[docs](https://example.test'),
      '[docs](https://example.test',
      'missing closing paren does not emit an anchor',
    );
    t.equal(
      renderMarkdownInline('[docs][missing'),
      '[docs][missing',
      'missing reference close bracket stays plain text',
    );
  });

  it('uses the last duplicate reference definition', (t) => {
    const html = renderMarkdown('[Docs][ref]\n\n[ref]: /first\n[REF]: /second');

    t.equal(html, '<p><a href="/second">Docs</a></p>', 'normalized duplicate references are last-write-wins');
  });

  it('omits unsafe parsed and resolved references by default', (t) => {
    const parsed = renderMarkdown('[Docs][ref]\n\n[ref]: javascript:alert(1)');
    const resolved = renderMarkdown('[Docs][ref]\n\n[ref]: /safe', {
      resolveLink() {
        return 'data:text/html,unsafe';
      },
    });

    t.equal(parsed, '<p>Docs</p>', 'unsafe parsed reference renders as label text');
    t.equal(resolved, '<p>Docs</p>', 'unsafe resolved reference renders as label text');
  });

  it('sanitizes default URL handling without enabling unsafe protocols', (t) => {
    t.equal(renderMarkdownInline('[http](http://example.test)'), '<a href="http://example.test">http</a>', 'http links are allowed');
    t.equal(renderMarkdownInline('[https](https://example.test)'), '<a href="https://example.test">https</a>', 'https links are allowed');
    t.equal(renderMarkdownInline('[relative](../guide)'), '<a href="../guide">relative</a>', 'relative links are allowed');
    t.equal(renderMarkdownInline('[mail](mailto:team@example.test)'), 'mail', 'other protocols are omitted by default');
  });
});
