import { describe, it } from 'fino:test/test';
import { compile, escapeHtml, render } from 'fino:template';

describe('fino:template — mustache core', () => {
  it('renders escaped, triple, and ampersand variables', (t) => {
    t.equal(escapeHtml('<b>"&\''), '&lt;b&gt;&quot;&amp;&#39;', 'escapeHtml escapes HTML-sensitive characters');
    t.equal(render('Hello {{name}}', { name: '<Fino>' }), 'Hello &lt;Fino&gt;');
    t.equal(render('Hello {{{name}}}', { name: '<Fino>' }), 'Hello <Fino>');
    t.equal(render('Hello {{& name}}', { name: '<Fino>' }), 'Hello <Fino>');
  });

  it('renders missing values as empty strings', (t) => {
    t.equal(render('A{{missing}}B', {}), 'AB');
  });

  it('renders sections, arrays, current value, and inverted sections', (t) => {
    const out = render(
      '{{#enabled}}yes{{/enabled}}{{^disabled}} no{{/disabled}} {{#items}}[{{.}}/{{../name}}]{{/items}}',
      { enabled: true, disabled: false, name: 'root', items: ['a', 'b'] },
    );
    t.equal(out, 'yes no [a/root][b/root]');
  });

  it('supports object sections and dotted lookups with parent fallback', (t) => {
    const out = render('{{#user}}{{profile.name}}:{{role}}:{{site.name}}{{/user}}', {
      role: 'admin',
      site: { name: 'docs' },
      user: { profile: { name: 'Ada' } },
    });
    t.equal(out, 'Ada:admin:docs');
  });

  it('omits comments and compiles reusable templates', (t) => {
    const tpl = compile('{{! hidden }}{{#items}}{{name}};{{/items}}');
    t.equal(tpl({ items: [{ name: 'one' }, { name: 'two' }] }), 'one;two;');
    t.equal(tpl({ items: [] }), '');
  });

  it('rejects malformed tags and names', (t) => {
    t.throws(() => compile('{{#}}{{/}}'), /empty section name/, 'empty section name rejected');
    t.throws(() => compile('{{user..name}}'), /malformed name/, 'empty dotted segment rejected');
    t.throws(() => compile('{{../}}'), /malformed name/, 'bare parent path rejected');
    t.throws(() => compile('{{> partial}}'), /partials are not supported/, 'partials rejected');
    t.throws(() => compile('{{=<% %>=}}<% name %>'), /delimiter changes are not supported/, 'delimiter changes rejected');
    t.throws(() => compile('{{#a}}{{/b}}'), /unmatched section close/, 'mismatched close rejected');
  });

  it('documents unsupported full Mustache features through explicit behavior', (t) => {
    const lambdaCalls: string[] = [];
    const out = render('{{#lambda}}value{{/lambda}}', {
      lambda() {
        lambdaCalls.push('called');
        return true;
      },
    });

    t.equal(out, 'value', 'function values are called as truthy section values');
    t.deepEqual(lambdaCalls, ['called'], 'function section value is invoked once');
    t.throws(() => compile('{{> partial}}'), /partials are not supported/, 'partial loading remains out of scope');
    t.throws(() => compile('{{=<% %>=}}<% name %>'), /delimiter changes are not supported/, 'custom delimiters remain out of scope');
  });
});
