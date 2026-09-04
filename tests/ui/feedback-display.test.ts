import { describe, it } from 'fino:test/test';
import { h } from 'fino:ui';
import type { VNode } from 'fino:ui';
import {
  Badge,
  Card,
  EmptyState,
  ProgressBar,
  SPINNER_FRAMES,
  Spinner,
  StatusDot,
  normalizeProgress,
} from 'fino:ui/components';
import { pageCss, toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';
import { displayPreviews } from 'internal:ui/components/display.preview';
import { feedbackPreviews } from 'internal:ui/components/feedback.preview';
import { defaultArgs } from 'internal:ui/preview';
import { createTuiHarness, plainLine } from './tui-harness.ts';

function html(tree: VNode): string {
  return renderToHtml(toHtml(tree));
}

describe('feedback and display components', () => {
  it('normalizes progress once for every target', (t) => {
    t.deepEqual(normalizeProgress(0.426), { fraction: 0.426, percent: 43 });
    t.deepEqual(normalizeProgress(2), { fraction: 1, percent: 100 });
    t.deepEqual(normalizeProgress(Number.NaN), { fraction: 0, percent: 0 });
  });

  it('renders safe and accessible HTML surfaces with one CSS registration', (t) => {
    const out = html(
      h(
        'fragment',
        null,
        h(ProgressBar, { value: 1.4, showPercent: true }),
        h(Card, { title: 'Unsafe', image: { src: 'javascript:alert(1)', alt: 'bad' } }),
        h(StatusDot, { status: 'busy' }),
        h(EmptyState, { title: 'Nothing here' }),
      ),
    );
    t.ok(out.includes('100%'));
    t.equal(out.includes('<img'), false);
    t.ok(out.includes('aria-label="busy"'));
    for (const marker of ['.ui-progress-wrap {', '.ui-card {']) {
      t.equal(pageCss().split(marker).length - 1, 1, `${marker} is registered once`);
    }
  });

  it('renders deterministic terminal feedback and display surfaces', (t) => {
    const app = createTuiHarness(40, 8);
    app.render(
      h(
        'fragment',
        null,
        h(Badge, { label: 'Ready', variant: 'success' }),
        h(Spinner, { tick: SPINNER_FRAMES.length + 2 }),
        h(ProgressBar, { value: 0.5, width: 4, showPercent: true }),
        h(StatusDot, { status: 'ok', label: 'Healthy' }),
      ),
    );
    const text = app.lines().map(plainLine).join('\n');
    t.ok(text.includes('Ready'));
    t.ok(text.includes(SPINNER_FRAMES[2]!));
    t.ok(text.includes('██░░ 50%'));
    t.ok(text.includes('Healthy'));
  });

  it('keeps feedback and display previews co-located and renderable', (t) => {
    for (const group of [feedbackPreviews(), displayPreviews()]) {
      t.ok(group.previews.length > 0);
      for (const preview of group.previews) {
        t.ok(html(preview.view(defaultArgs(preview))).length > 0, `${group.title}/${preview.key}`);
      }
    }
  });
});
