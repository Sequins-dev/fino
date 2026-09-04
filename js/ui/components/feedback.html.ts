/** HTML lowerings and styles for feedback components. @internal */
import { h } from 'fino:ui';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import { componentStyleAttrs, nativeAction } from 'internal:ui/components/html-runtime';
import {
  Badge,
  KeyHint,
  ProgressBar,
  Spinner,
  Tag,
  normalizeProgress,
} from 'internal:ui/components/feedback';
import type { ToneVariant } from 'internal:ui/components/feedback';
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';

function toneClass(tone: ToneVariant | undefined): string {
  return `is-${tone ?? 'accent'}`;
}

mapComponentLowering(Badge, 'html', (props) =>
  h(
    'span',
    componentStyleAttrs(props as Props, `ui-badge ${toneClass(props.variant)}`),
    props.label,
  ),
);

mapComponentLowering(Spinner, 'html', (props) =>
  h('span', {
    ...componentStyleAttrs(props as Props, 'ui-spinner'),
    role: 'status',
    'aria-label': 'loading',
  }),
);

mapComponentLowering(ProgressBar, 'html', (props) => {
  const progress = normalizeProgress(props.value);
  return h(
    'span',
    componentStyleAttrs(props as Props, 'ui-progress-wrap'),
    h('progress', {
      className: 'ui-progress',
      max: '100',
      value: String(progress.percent),
    }),
    props.showPercent === true
      ? h('span', { className: 'ui-progress-percent' }, `${progress.percent}%`)
      : null,
  );
});

mapComponentLowering(KeyHint, 'html', (props) => {
  const content: NormalizedChild[] = [];
  props.keys.forEach((entry, index) => {
    if (index > 0)
      content.push(h('span', { className: 'ui-keyhint-sep' }, props.separator ?? ' · '));
    content.push(h('kbd', null, entry.key), ` ${entry.label}`);
  });
  return h('span', componentStyleAttrs(props as Props, 'ui-keyhint'), ...content);
});

mapComponentLowering(Tag, 'html', (props) => {
  const remover: VNode | null =
    props.onRemove === undefined
      ? null
      : nativeAction(
          h('button', { className: 'ui-tag-remove', 'aria-label': `Remove ${props.label}` }, '×'),
          props.onRemove,
        );
  return h(
    'span',
    componentStyleAttrs(props as Props, `ui-tag ${toneClass(props.color)}`),
    props.label,
    remover,
  );
});

registerHtmlCss(`
.ui-badge, .ui-tag {
  display: inline-flex; align-items: center; gap: 0.25rem; width: fit-content;
  padding: 0.1rem 0.45rem; border: 1px solid currentColor; border-radius: 999px;
  font-size: 0.85em; line-height: 1.35;
}
.ui-badge.is-accent, .ui-tag.is-accent { color: var(--tui-cyan); }
.ui-badge.is-muted, .ui-tag.is-muted { color: var(--tui-bright-black); }
.ui-badge.is-danger, .ui-tag.is-danger { color: var(--tui-red); }
.ui-badge.is-success, .ui-tag.is-success { color: var(--tui-green); }
.ui-badge.is-warning, .ui-tag.is-warning { color: var(--tui-yellow); }
.ui-spinner {
  display: inline-block; width: 1em; height: 1em; border: 2px solid var(--ui-border);
  border-top-color: var(--tui-cyan); border-radius: 50%; animation: ui-spin 800ms linear infinite;
}
@keyframes ui-spin { to { transform: rotate(360deg); } }
.ui-progress-wrap { display: inline-flex; align-items: center; gap: 0.5rem; }
.ui-progress { accent-color: var(--tui-cyan); }
.ui-progress-percent, .ui-keyhint-sep { color: var(--tui-bright-black); }
.ui-keyhint kbd {
  padding: 0.05rem 0.3rem; border: 1px solid var(--ui-border); border-radius: 0.2rem;
  background: var(--ui-surface); font: inherit; font-weight: 700;
}
.ui-tag .ui-action { display: inline; }
.ui-tag-remove { border: 0; padding: 0; background: transparent; color: inherit; cursor: pointer; }
`);
