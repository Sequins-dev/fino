/**
* Typography coverage for the TypeScript performance presentation.
*/
import { describe, it } from 'fino:test/test';
import { h } from 'fino:ui';
import { renderToHtml } from 'fino:ui/html';
import { Callout, Lead } from '../demos/typescript-performance-components.tsx';

describe('TypeScript performance deck', () => {
  it('keeps title-slide subtitles subordinate to their headings', (t) => {
    const html = renderToHtml(h(Lead, null, 'A supporting statement.'));

    t.ok(html.includes('font-size:2.1em'), 'lead text uses a restrained display size');
  });

  it('uses an ink callout surface with an amber accent', (t) => {
    const html = renderToHtml(h(Callout, { label: 'Context' }, 'Supporting context.'));

    t.ok(html.includes('background:#0d1b1e;color:#f4f0e5'), 'callout text remains legible against its ink surface');
    t.ok(html.includes('border-left:.55em solid #f3aa18'), 'callout retains amber as a restrained accent');
  });

  it('sets callout copy in a readable non-condensed face', (t) => {
    const html = renderToHtml(h(Callout, { label: 'Context' }, 'Supporting context.'));

    t.ok(html.includes('font-family:&quot;Avenir Next&quot;,&quot;Helvetica Neue&quot;,sans-serif;font-size:1.15em;font-weight:600;line-height:1.3;letter-spacing:.005em'), 'callout copy uses open spacing and moderate weight');
  });
});
