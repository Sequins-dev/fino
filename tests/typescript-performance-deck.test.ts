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

  it('uses a high-contrast dark amber callout surface', (t) => {
    const html = renderToHtml(h(Callout, { label: 'Context' }, 'Supporting context.'));

    t.ok(html.includes('background:#9a5b00;color:#f4f0e5'), 'callout text remains legible against its amber surface');
  });
});
