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

  it('renders nested lists as nested list items', (t) => {
    const html = renderMarkdown('- parent\n  - child\n- sibling');

    t.equal(
      html,
      '<ul>\n<li>parent\n<ul>\n<li>child</li>\n</ul>\n</li>\n<li>sibling</li>\n</ul>\n',
      'indented nested markers stay inside their parent list item',
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

  it('renders CommonMark block constructs', (t) => {
    t.equal(renderMarkdown('> quoted'), '<blockquote>\n<p>quoted</p>\n</blockquote>\n', 'blockquotes render as blockquotes');
    t.equal(renderMarkdown('Title\n====='), '<h1>Title</h1>\n', 'Setext headings render as headings');
    t.equal(renderMarkdown('---'), '<hr />\n', 'thematic breaks render as horizontal rules');
  });

  it('renders GFM tables with alignment and inline spans', (t) => {
    const html = renderMarkdown('| Name | Score | Note |\n| :--- | ---: | :---: |\n| **Ada** | 5 < 7 | `ok` |');

    t.equal(
      html,
      '<table>\n<thead>\n<tr>\n<th align="left">Name</th>\n<th align="right">Score</th>\n<th align="center">Note</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td align="left"><strong>Ada</strong></td>\n<td align="right">5 &lt; 7</td>\n<td align="center"><code>ok</code></td>\n</tr>\n</tbody>\n</table>\n',
      'tables render with alignment, escaped cells, and inline markup',
    );
  });

  it('keeps lazy continuation lines inside list items', (t) => {
    t.equal(
      renderMarkdown('- first\n  continuation\n- second'),
      '<ul>\n<li>first\ncontinuation</li>\n<li>second</li>\n</ul>\n',
    );
  });

  it('follows CommonMark tight and loose list behavior', (t) => {
    t.equal(renderMarkdown('- tight\n- list'), '<ul>\n<li>tight</li>\n<li>list</li>\n</ul>\n', 'tight lists omit paragraph wrappers');
    t.equal(renderMarkdown('- loose\n\n- list'), '<ul>\n<li>\n<p>loose</p>\n</li>\n<li>\n<p>list</p>\n</li>\n</ul>\n', 'loose lists keep paragraph wrappers');
  });

  it('renders focused GFM inline and table extensions', (t) => {
    t.equal(renderMarkdownInline('~~done~~'), '<del>done</del>', 'strikethrough renders as del');
    t.equal(renderMarkdown('- [x] shipped\n- [ ] pending'), '<ul>\n<li><input type="checkbox" checked="" disabled="" /> shipped</li>\n<li><input type="checkbox" disabled="" /> pending</li>\n</ul>\n', 'task lists render checkbox markers');
    t.equal(renderMarkdownInline('https://example.test/docs'), '<a href="https://example.test/docs">https://example.test/docs</a>', 'bare autolinks render as anchors');
    t.equal(renderMarkdown('| a \\| b | c |\n| --- | --- |\n| x | y |'), '<table>\n<thead>\n<tr>\n<th>a | b</th>\n<th>c</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>x</td>\n<td>y</td>\n</tr>\n</tbody>\n</table>\n', 'escaped pipes stay in table cells');
    t.equal(renderMarkdown('- a\n\n| b | c |\n| - | - |'), '<ul>\n<li>a</li>\n</ul>\n<table>\n<thead>\n<tr>\n<th>b</th>\n<th>c</th>\n</tr>\n</thead>\n</table>\n', 'table starts after the list instead of being absorbed');
  });

  it('filters disallowed raw HTML tags even when raw HTML is enabled', (t) => {
    t.equal(renderMarkdown('<xmp>unsafe</xmp>', { allowRawHtml: true }), '&lt;xmp>unsafe&lt;/xmp>\n');
  });

  it('allows raw HTML only when explicitly requested', (t) => {
    t.equal(renderMarkdown('<div>\nraw\n</div>', { allowRawHtml: true }), '<div>\nraw\n</div>\n');
  });
});
