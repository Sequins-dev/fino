/** @jsxImportSource fino:ui */
import { describe, it } from 'fino:test/test';
import { Code } from 'fino:ui/components';
import { toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';

const html = (node: ReturnType<typeof Code>): string => renderToHtml(toHtml(node));
const src = 'const a = 1;\n';

describe('code block bar and copy button', () => {
  it('marks code content so the copy excludes line numbers', (t) => {
    const out = html(
      <Code code={'const a = 1;\nconst b = 2;\n'} language="ts" showLineNumbers copyable />,
    );
    const contents = out.split('ui-code-content').length - 1;
    t.ok(contents >= 2, `each line wraps its content separately (${contents})`);
    t.ok(out.includes('ui-code-num'), 'line numbers are their own element');
  });

  it('omits the bar entirely without a filename', (t) => {
    const out = html(<Code code={src} language="ts" />);
    t.ok(!out.includes('ui-code-bar'), 'no bar when there is no filename');
    t.ok(!out.includes('ui-copy'), 'no copy button unless asked for');
  });

  it('shows the bar only when a filename is given', (t) => {
    const named = html(<Code code={src} language="ts" filename="a.ts" />);
    t.ok(named.includes('ui-code-bar'), 'named block gets a bar');
    t.ok(named.includes('a.ts'), 'filename is shown');
    const copyOnly = html(<Code code={src} language="ts" copyable />);
    t.ok(!copyOnly.includes('ui-code-bar'), 'copyable alone does not create a bar');
  });

  it('overlays the copy button when there is no filename bar', (t) => {
    const out = html(<Code code={src} language="ts" copyable />);
    t.ok(out.includes('data-fi-copy'), 'copy button present');
    const copyAt = out.indexOf('ui-copy');
    const preAt = out.indexOf('<pre');
    t.ok(copyAt >= 0 && copyAt < preAt, 'button precedes the code so it can overlay it');
    t.ok(out.includes('aria-label="Copy code"'), 'button is labelled for assistive tech');
  });

  it('puts the copy button inside the bar when both are present', (t) => {
    const out = html(<Code code={src} language="ts" filename="a.ts" copyable />);
    const barAt = out.indexOf('ui-code-bar');
    const copyAt = out.indexOf('ui-copy');
    const capEnd = out.indexOf('</figcaption>');
    t.ok(barAt < copyAt && copyAt < capEnd, 'button lives inside the filename bar');
  });
});
