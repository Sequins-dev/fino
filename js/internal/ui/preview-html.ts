/** Static and server-driven HTML runners for preview catalogs. @internal */
import { Signal, h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import { htmlPage, pageCss, toHtml } from 'fino:ui/components/html';
import { rawHtml, renderToHtml } from 'fino:ui/html';
import type { ServeServer } from 'fino:net/http/server';
import { App, cookies, sessions } from 'fino:net/http/app';
import { memoryStore } from 'fino:store';
import { ViewActionError, clientScriptPath, page, view, webUI } from 'fino:ui/web';
import type { PortableActionRef } from 'fino:ui/web';
import { findPreview, parseArgs, selectPreview } from 'internal:ui/preview';
import type { Preview, PreviewArgs, PreviewGroup } from 'internal:ui/preview';

type PreviewAction = (value?: string) => void;

function previewFields(preview: Preview, args: PreviewArgs): Record<string, string> {
  const fields: Record<string, string> = { preview: preview.key };
  for (const [name, value] of Object.entries(args)) fields[name] = String(value);
  return fields;
}

function lowerPreview(
  preview: Preview,
  args: PreviewArgs,
  options: {
    actions?: Map<string, PreviewAction>;
    action?: PortableActionRef;
    fields?: Record<string, string>;
  } = {},
): { tree: VNode; actions: Map<string, PreviewAction> } {
  const actions = options.actions ?? new Map<string, PreviewAction>();
  return {
    actions,
    tree: toHtml(preview.view(args), {
      actions,
      ...(options.action === undefined ? {} : { action: options.action }),
      ...(options.fields === undefined ? {} : { fields: options.fields }),
    }),
  };
}

function controlsForm(preview: Preview, args: PreviewArgs, action?: PortableActionRef): VNode {
  const change = action === undefined ? { onchange: 'this.form.submit()' } : {};
  const rows = Object.entries(preview.controls ?? {}).map(([name, control]) => {
    const label = control.label ?? name;
    const value = args[name] ?? control.default;
    let field: VNode;
    if (control.type === 'boolean') {
      field = h(
        'span',
        null,
        h('input', { type: 'hidden', name, value: 'false' }),
        h('input', {
          type: 'checkbox',
          name,
          value: 'true',
          checked: value === true,
          ...change,
        }),
      );
    } else if (control.type === 'select') {
      field = h(
        'select',
        { name, ...change },
        ...control.options.map((option) =>
          h('option', { key: option, value: option, selected: option === value }, option),
        ),
      );
    } else if (control.type === 'number') {
      field = h('input', {
        type: 'number',
        name,
        value: String(value),
        step: String(control.step ?? 1),
        ...(control.min === undefined ? {} : { min: String(control.min) }),
        ...(control.max === undefined ? {} : { max: String(control.max) }),
        ...change,
      });
    } else {
      field = h('input', { type: 'text', name, value: String(value), ...change });
    }
    return h(
      'label',
      { key: name, style: { display: 'flex', gap: '1ch', alignItems: 'center' } },
      h('span', { style: { opacity: '0.55', minWidth: '10ch' } }, label),
      field,
    );
  });
  const formProps: Props =
    action === undefined ? { method: 'get' } : { action, method: 'post', 'data-fi-change': '' };
  formProps.style = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    marginTop: '1rem',
  };
  return h(
    'form',
    formProps,
    h('div', { style: { opacity: '0.55', fontWeight: 'bold' } }, 'controls'),
    action === undefined
      ? h('input', { type: 'hidden', name: 'preview', value: preview.key })
      : null,
    ...rows,
    h(
      'button',
      {
        type: 'submit',
        style: {
          alignSelf: 'flex-start',
          border: '1px solid var(--tui-border)',
          padding: '0 0.5rem',
          cursor: 'pointer',
        },
      },
      'Apply',
    ),
  );
}

function sidebar(groups: readonly PreviewGroup[], activeKey: string | undefined): VNode {
  return h(
    'nav',
    { style: { minWidth: '12rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' } },
    ...groups.flatMap((group) => [
      h('div', { key: group.title, style: { opacity: '0.55', marginTop: '0.75rem' } }, group.title),
      ...group.previews.map((preview) =>
        h(
          'a',
          {
            key: preview.key,
            href: `?preview=${encodeURIComponent(preview.key)}`,
            style: preview.key === activeKey ? { fontWeight: 'bold' } : {},
          },
          preview.name,
        ),
      ),
    ]),
  );
}

/** Render one preview as a complete progressively enhanced HTML page. */
export function previewPage(
  groups: PreviewGroup[],
  selectedKey: string | null,
  rawArgs: Record<string, string> = {},
  actions?: Map<string, PreviewAction>,
): string {
  const { preview, args } = selectPreview(groups, selectedKey, rawArgs);
  const pane = h(
    'main',
    { style: { flex: '1 0 auto', position: 'relative' } },
    h('h1', { style: { fontSize: '1rem', marginBottom: '1lh' } }, preview?.name ?? 'No previews'),
    preview === undefined
      ? h('p', null, 'Nothing to show.')
      : lowerPreview(preview, args, {
          actions,
          fields: previewFields(preview, args),
        }).tree,
    preview?.controls === undefined ? null : controlsForm(preview, args),
  );
  const document = h(
    'div',
    { style: { display: 'flex', gap: '4ch' } },
    sidebar(groups, preview?.key),
    pane,
  );
  return htmlPage(renderToHtml(document), {
    title: `fino ui — ${preview?.name ?? 'preview'}`,
  });
}

function queryArgs(url: URL): Record<string, string> {
  const args: Record<string, string> = {};
  for (const name of new Set(url.searchParams.keys())) {
    if (name === 'preview') continue;
    const values = url.searchParams.getAll(name);
    args[name] = values[values.length - 1] ?? '';
  }
  return args;
}

let previewAppCounter = 0;

/** Build a live preview application over the existing server-view protocol. */
export function createPreviewApp(groups: PreviewGroup[]): App {
  const instance = previewAppCounter++;
  const secret = `fino-preview-${instance}-${crypto.randomUUID()}`;
  const app = new App();
  const routes = app
    .value('cookies', cookies())
    .value(
      'session',
      sessions({
        store: memoryStore({ namespace: `preview-sessions-${instance}` }),
        keys: [{ id: 'preview', secret: `${secret}-session` }],
        cookieOptions: { secure: false },
        ttlMs: 24 * 36e5,
      }),
    )
    .layer(webUI({ store: memoryStore(), secret, sweepIntervalMs: false }));

  const storyView = view({
    id: `fino:preview/catalog-${instance}`,
    state: () => ({
      preview: new Signal(''),
      args: new Signal<Record<string, string>>({}),
    }),
    actions: {
      invoke: {
        handler({ state }, input) {
          const preview = findPreview(groups, state.preview.get() as string);
          if (preview === undefined) {
            throw new ViewActionError('action_not_found', { status: 404, recoverable: false });
          }
          const args = parseArgs(preview, state.args.get() as Record<string, string>);
          const { actions } = lowerPreview(preview, args);
          const body = input as { do?: unknown; value?: unknown };
          const invoke = typeof body.do === 'string' ? actions.get(body.do) : undefined;
          if (invoke === undefined) {
            throw new ViewActionError('action_not_found', { status: 404, recoverable: true });
          }
          invoke(typeof body.value === 'string' ? body.value : undefined);
        },
      },
      configure: {
        handler({ state }, input) {
          const next: Record<string, string> = {};
          for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
            if (typeof value === 'string') next[name] = value;
          }
          state.args.set(next);
        },
      },
    },
    render({ state, actions }) {
      const { preview, args } = selectPreview(
        groups,
        state.preview.get() as string,
        state.args.get() as Record<string, string>,
      );
      if (preview === undefined) return h('p', null, 'No previews');
      return h(
        'main',
        { style: { flex: '1 1 auto', position: 'relative' } },
        h('h1', { style: { fontSize: '1rem', marginBottom: '1rem' } }, preview.name),
        lowerPreview(preview, args, { action: actions.invoke }).tree,
        preview.controls === undefined ? null : controlsForm(preview, args, actions.configure),
      );
    },
  });

  routes.get('/').handle(
    page((ctx) => {
      const url = new URL(ctx.request.url);
      const { preview } = selectPreview(groups, url.searchParams.get('preview'));
      return h(
        'html',
        null,
        h(
          'head',
          null,
          h('meta', { charset: 'utf-8' }),
          h('title', null, `fino ui — ${preview?.name ?? 'preview'}`),
          h('style', null, rawHtml(pageCss())),
        ),
        h(
          'body',
          null,
          h(
            'div',
            { className: 'ui-root', style: { display: 'flex', gap: '3rem' } },
            sidebar(groups, preview?.key),
            h(
              'div',
              { style: { flex: '1 1 auto' } },
              preview === undefined
                ? h('p', null, 'No previews')
                : storyView.mount(ctx, { preview: preview.key, args: queryArgs(url) }),
            ),
          ),
          h('script', { src: clientScriptPath(), defer: true }),
        ),
      );
    }),
  );
  return app;
}

/** Listen for a live preview application. */
export function runPreviewHtml(options: {
  port?: number;
  hostname?: string;
  groups: PreviewGroup[];
}): ServeServer {
  return createPreviewApp(options.groups).listen({
    port: options.port ?? 3080,
    hostname: options.hostname ?? '127.0.0.1',
  }) as ServeServer;
}
