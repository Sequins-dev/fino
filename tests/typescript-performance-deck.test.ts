/**
* Typography coverage for the TypeScript performance presentation.
*/
import { describe, it } from 'fino:test/test';
import { h } from 'fino:ui';
import { renderToHtml } from 'fino:ui/html';
import { Lead } from '../demos/typescript-performance-components.tsx';

describe('TypeScript performance deck', () => {
  it('keeps title-slide subtitles subordinate to their headings', (t) => {
    const html = renderToHtml(h(Lead, null, 'A supporting statement.'));

    t.ok(html.includes('font-size:2.1em'), 'lead text uses a restrained display size');
  });
});
