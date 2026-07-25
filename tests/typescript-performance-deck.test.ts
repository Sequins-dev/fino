/**
* Typography coverage for the TypeScript performance presentation.
*/
import { describe, it } from 'fino:test/test';
import { h } from 'fino:ui';
import { renderToHtml } from 'fino:ui/html';
import { DiskFileSystem } from 'fino:file';
import { Callout, Lead } from '../demos/typescript-performance-components.tsx';
const fs = new DiskFileSystem();
describe('TypeScript performance deck', () => {
  it('keeps title-slide subtitles subordinate to their headings', (t) => {
    const html = renderToHtml(h(Lead, null, 'A supporting statement.'));
    t.ok(html.includes('font-size:2.1em'), 'lead text uses a restrained display size');
  });
  it('uses a rich amber callout surface with ink text', (t) => {
    const html = renderToHtml(h(Callout, { label: 'Context' }, 'Supporting context.'));
    t.ok(html.includes('background:#d88a00;color:#0d1b1e'), 'callout uses a deeper golden amber with dark text');
  });
  it('sets callout copy in a readable non-condensed face', (t) => {
    const html = renderToHtml(h(Callout, { label: 'Context' }, 'Supporting context.'));
    t.ok(html.includes('font-family:&quot;Avenir Next&quot;,&quot;Helvetica Neue&quot;,sans-serif;font-size:1.15em;font-weight:600;line-height:1.3;letter-spacing:.005em'), 'callout copy uses open spacing and moderate weight');
  });
  it('organizes the architecture story into five substantial chapters', async (t) => {
    const source = new TextDecoder().decode(await fs.readFile('./demos/typescript-performance.mdx'));
    t.equal(source.split('\n---\n').length, 37, 'the expanded deck has enough room to develop its argument');
    for (const title of [
      'Coordination is the runtime',
      'Reuse is an architectural decision',
      'Make the boundary boring',
      'Native must earn the crossing',
      'Choose by total work'
    ]) {
      t.ok(source.includes(`# ${title}`), `the deck includes the “${title}” chapter`);
    }
  });
});
