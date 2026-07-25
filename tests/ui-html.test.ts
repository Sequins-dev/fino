import { describe, it } from 'fino:test/test';
import { h, Fragment } from 'fino:ui';
import { rawHtml, renderToHtml } from 'fino:ui/html';

describe('fino:ui/html', () => {
  it('serializes VNodes with escaped text, attributes, booleans, style objects, and fragments', (t) => {
    const html = renderToHtml(h('section', {
      id: 'root',
      className: 'panel',
      hidden: false,
      disabled: true,
      style: { color: 'red', backgroundColor: 'white' },
      title: '"quoted" & <tag>'
    }, h(Fragment, null, 'Hello <Ada>', h('input', {
      name: 'q',
      value: 'a&b',
      checked: true
    }))));

    t.equal(
      html,
      '<section id="root" class="panel" disabled style="color:red;background-color:white" title="&quot;quoted&quot; &amp; &lt;tag&gt;">Hello &lt;Ada&gt;<input name="q" value="a&amp;b" checked></section>'
    );
  });

  it('allows explicit raw HTML and rejects function props', (t) => {
    t.equal(renderToHtml(h('div', null, rawHtml('<span>ok</span>'))), '<div><span>ok</span></div>');
    t.throws(() => renderToHtml(h('button', { onclick: () => {} }, 'Run')), /function prop "onclick"/);
  });
});
