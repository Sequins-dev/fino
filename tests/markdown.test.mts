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
});
