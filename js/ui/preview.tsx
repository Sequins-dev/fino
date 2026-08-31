/** @jsxImportSource fino:ui */
/**
 * fino:ui/preview — a browsable preview of the component catalog, in both render
 * targets.
 *
 * A preview is a named view function; groups of previews describe the catalog.
 * The same previews drive two runners: `runPreviewTui()` renders a live,
 * navigable preview in the terminal (sidebar + preview, arrow keys and mouse),
 * and `runPreviewHtml()` serves the preview over HTTP with each preview
 * transformed to HTML by `fino:ui/components/html`. Because both consume the
 * identical preview trees, the preview doubles as the dual-target conformance
 * surface: a component that renders sensibly in one target and not the other
 * is a bug you can see.
 *
 * ```ts no_run
 * import { runPreviewTui } from 'fino:ui/preview';
 * await runPreviewTui();               // fino preview.ts, in a terminal
 * ```
 *
 * ```ts no_run
 * import { runPreviewHtml } from 'fino:ui/preview';
 * await runPreviewHtml({ port: 3080 }); // then open http://localhost:3080
 * ```
 */
import { Signal, createSignal } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import {
  Box,
  Checkbox,
  Clickable,
  HStack,
  ListSelection,
  MenuList,
  Panel,
  Rule,
  Text,
  VStack,
  styles,
} from 'fino:ui/components';
import type { MenuItem } from 'fino:ui/components';
import { render, getTerminalSize } from 'fino:tty/tui';
import { signal as processSignal } from 'fino:process';
import { PAGE_CSS, toHtml, htmlPage } from 'fino:ui/components/html';
import { rawHtml, renderToHtml } from 'fino:ui/html';
import type { ServeServer } from 'fino:net/http/server';
import { App, cookies, sessions } from 'fino:net/http/app';
import { memoryCache } from 'fino:cache';
import { ViewActionError, clientScriptPath, page, view, webUI } from 'fino:ui/web';
import { InMemoryViewStore } from 'fino:ui/web/state';
import { defaultArgs, parseArgs } from 'internal:ui/preview';
import type {
  Control,
  ControlValue,
  Preview,
  PreviewArgs,
  PreviewGroup,
} from 'internal:ui/preview';
import { layoutPreviews } from 'internal:ui/components/layout.preview';
import { formsPreviews } from 'internal:ui/components/forms.preview';
import { indicatorsPreviews } from 'internal:ui/components/indicators.preview';
import { feedbackPreviews } from 'internal:ui/components/feedback.preview';
import { navigationPreviews } from 'internal:ui/components/navigation.preview';
import { disclosurePreviews } from 'internal:ui/components/disclosure.preview';
import { overlayPreviews } from 'internal:ui/components/overlay.preview';
import { dataPreviews } from 'internal:ui/components/data.preview';
import { typographyPreviews } from 'internal:ui/components/typography.preview';
import { displayPreviews } from 'internal:ui/components/display.preview';
import { pickersPreviews } from 'internal:ui/components/pickers.preview';
import { chartsPreviews } from 'internal:ui/components/charts.preview';

export { defaultArgs, parseArgs };
export type { Control, ControlValue, Preview, PreviewArgs, PreviewGroup };

/**
 * Every preview group in catalog order. Each group lives beside the components
 * it demonstrates, in `js/ui/components/*.previews.tsx`.
 */
export function catalogPreviews(): PreviewGroup[] {
  return [
    layoutPreviews(),
    formsPreviews(),
    indicatorsPreviews(),
    feedbackPreviews(),
    navigationPreviews(),
    disclosurePreviews(),
    overlayPreviews(),
    dataPreviews(),
    typographyPreviews(),
    displayPreviews(),
    pickersPreviews(),
    chartsPreviews(),
  ];
}

function storyItems(groups: PreviewGroup[]): MenuItem[] {
  const items: MenuItem[] = [];
  for (const group of groups) {
    items.push({ kind: 'header', label: group.title });
    for (const preview of group.previews) items.push({ key: preview.key, label: preview.name });
  }
  return items;
}

function findPreview(groups: PreviewGroup[], key: string | null): Preview | undefined {
  for (const group of groups) {
    for (const preview of group.previews) if (preview.key === key) return preview;
  }
  return undefined;
}

interface ControlsPaneProps {
  preview: Preview;
  args: PreviewArgs;
  onChange: (name: string, value: ControlValue) => void;
}

function ControlsPane(props: ControlsPaneProps): VNode {
  const { preview, args, onChange } = props;
  const entries = Object.entries(preview.controls ?? {});
  return (
    <VStack>
      <Rule style={[styles.dim]} />
      <Text style={[styles.dim, styles.bold]}>controls</Text>
      {entries.map(([name, control]) => {
        const label = control.label ?? name;
        const value = args[name] ?? control.default;
        if (control.type === 'boolean') {
          return (
            <Checkbox
              key={name}
              id={`control:${name}`}
              checked={value === true}
              label={label}
              onChange={(next) => onChange(name, next)}
            />
          );
        }
        if (control.type === 'select') {
          const index = control.options.indexOf(String(value));
          const next = control.options[(index + 1) % control.options.length]!;
          return (
            <Clickable
              key={name}
              id={`control:${name}`}
              direction="row"
              gap={1}
              onClick={() => onChange(name, next)}
            >
              <Text style={[styles.muted]}>{label}:</Text>
              <Text style={[styles.accent]}>{`${String(value)} ▸`}</Text>
            </Clickable>
          );
        }
        if (control.type === 'number') {
          const step = control.step ?? 1;
          const current = Number(value);
          const clamp = (raw: number): number => {
            let out = raw;
            if (control.max !== undefined) out = Math.min(out, control.max);
            if (control.min !== undefined) out = Math.max(out, control.min);
            return out;
          };
          return (
            <HStack key={name} gap={1}>
              <Text style={[styles.muted]}>{label}:</Text>
              <Clickable
                id={`control:${name}:down`}
                onClick={() => onChange(name, clamp(current - step))}
              >
                <Text style={[styles.accent, styles.bold]}>−</Text>
              </Clickable>
              <Text>{String(current)}</Text>
              <Clickable
                id={`control:${name}:up`}
                onClick={() => onChange(name, clamp(current + step))}
              >
                <Text style={[styles.accent, styles.bold]}>+</Text>
              </Clickable>
            </HStack>
          );
        }
        return (
          <Clickable
            key={name}
            id={`control:${name}`}
            direction="row"
            gap={1}
            onKey={(event) => {
              if (event.key === 'backspace') {
                onChange(name, String(value).slice(0, -1));
                return true;
              }
              if (
                event.text !== undefined &&
                event.text.length === 1 &&
                !event.ctrl &&
                !event.alt
              ) {
                onChange(name, String(value) + event.text);
                return true;
              }
              return false;
            }}
          >
            <Text style={[styles.muted]}>{label}:</Text>
            <Text style={[styles.accent]}>{`${String(value)}▏`}</Text>
          </Clickable>
        );
      })}
    </VStack>
  );
}

/**
 * Run the preview as a live fullscreen terminal app. Arrow keys and clicks
 * choose a preview, the preview stays interactive, control rows adjust the
 * preview's configuration in place (click text controls to focus, then type),
 * and `q` quits.
 */
export async function runPreviewTui(groups: PreviewGroup[] = catalogPreviews()): Promise<void> {
  const size = createSignal(getTerminalSize());
  const selection = new ListSelection({ maxRows: Math.max(4, size.get().height - 6) });
  selection.setItems(storyItems(groups));
  const winch = processSignal('SIGWINCH').subscribe(() => {
    const next = getTerminalSize();
    selection.setMaxRows(Math.max(4, next.height - 6));
    size.set(next);
  });
  const selected = createSignal<string | null>(selection.selectedKey);
  const argsByPreview = new Map<string, ReturnType<typeof createSignal<PreviewArgs>>>();

  function argsFor(preview: Preview): ReturnType<typeof createSignal<PreviewArgs>> {
    let existing = argsByPreview.get(preview.key);
    if (!existing) {
      existing = createSignal<PreviewArgs>(defaultArgs(preview));
      argsByPreview.set(preview.key, existing);
    }
    return existing;
  }

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const view = (): VNode => {
    const preview = findPreview(groups, selected.get());
    const args = preview ? argsFor(preview) : null;
    return (
      <HStack grow={1} gap={1} height={size.get().height}>
        <Panel title="Previews" width={24} height={size.get().height}>
          <Clickable
            focusable={false}
            direction="column"
            onMouse={(event) => {
              if (event.action !== 'wheel') return false;
              if (selection.move(event.button === 'wheel-up' ? -1 : 1)) {
                selected.set(selection.selectedKey);
              }
              return true;
            }}
          >
            <MenuList
              id="previews"
              items={selection.items as MenuItem[]}
              selectedKey={selected.get()}
              top={selection.top}
              maxRows={selection.maxRows}
              onSelect={(key) => {
                selection.selectKey(key);
                selected.set(key);
              }}
            />
          </Clickable>
        </Panel>
        <Panel title={preview?.name ?? '—'} grow={1} height={size.get().height}>
          <Box grow={1} direction="column">
            {preview && args ? (
              preview.view(args.get())
            ) : (
              <Text style={[styles.muted]}>No preview selected</Text>
            )}
          </Box>
          {preview && args && preview.controls ? (
            <ControlsPane
              preview={preview}
              args={args.get()}
              onChange={(name, value) => args.set({ ...args.get(), [name]: value })}
            />
          ) : null}
          <Text style={[styles.dim]}>↑↓ preview · q quit</Text>
        </Panel>
      </HStack>
    );
  };

  const app = render(view, {
    input: true,
    mouse: true,
    onEvent: (event) => {
      if (event.type !== 'key') return;
      if (event.key === 'q' || (event.key === 'c' && event.ctrl)) {
        winch.dispose();
        app.stop();
        resolveDone();
        return;
      }
      if (selection.handleKey(event)) selected.set(selection.selectedKey);
    },
  });
  await done;
}

function controlsForm(preview: Preview, args: PreviewArgs, action?: unknown): VNode {
  // With a fino:ui/web action descriptor the form posts as a JSON envelope
  // and the page updates over SSE; the client's change listener handles
  // auto-submit. Without one, plain GET forms with inline resubmission.
  const change: Props = action === undefined ? { onchange: 'this.form.submit()' } : {};
  const rows = Object.entries(preview.controls ?? {}).map(([name, control]) => {
    const label = control.label ?? name;
    const value = args[name] ?? control.default;
    let field: VNode;
    if (control.type === 'boolean') {
      field = (
        <span>
          <input type="hidden" name={name} value="false" />
          <input type="checkbox" name={name} value="true" checked={value === true} {...change} />
        </span>
      );
    } else if (control.type === 'select') {
      field = (
        <select name={name} {...change}>
          {control.options.map((option) => (
            <option key={option} value={option} selected={option === value}>
              {option}
            </option>
          ))}
        </select>
      );
    } else if (control.type === 'number') {
      field = (
        <input
          type="number"
          name={name}
          value={String(value)}
          step={String(control.step ?? 1)}
          {...(control.min !== undefined ? { min: String(control.min) } : {})}
          {...(control.max !== undefined ? { max: String(control.max) } : {})}
          {...change}
        />
      );
    } else {
      field = <input type="text" name={name} value={String(value)} {...change} />;
    }
    return (
      <label key={name} style={{ display: 'flex', gap: '1ch', alignItems: 'center' }}>
        <span style={{ opacity: '0.55', minWidth: '10ch' }}>{label}</span>
        {field}
      </label>
    );
  });
  const formProps: Props =
    action === undefined ? { method: 'get' } : { action, method: 'post', 'data-fi-change': '' };
  formProps.style = { display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '1rem' };
  return (
    <form {...formProps}>
      <div style={{ opacity: '0.55', fontWeight: 'bold' }}>controls</div>
      {action === undefined ? <input type="hidden" name="preview" value={preview.key} /> : null}
      {rows}
      <button
        type="submit"
        style={{
          alignSelf: 'flex-start',
          border: '1px solid var(--tui-border)',
          padding: '0 0.5rem',
          cursor: 'pointer',
        }}
      >
        Apply
      </button>
    </form>
  );
}

function sidebarNav(groups: PreviewGroup[], activeKey: string | undefined): VNode {
  return (
    <nav style={{ minWidth: '12rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      {groups.flatMap((group) => [
        <div key={group.title} style={{ opacity: '0.55', marginTop: '0.75rem' }}>
          {group.title}
        </div>,
        ...group.previews.map((entry) => (
          <a
            key={entry.key}
            href={`?preview=${entry.key}`}
            style={entry.key === activeKey ? { fontWeight: 'bold' } : {}}
          >
            {entry.name}
          </a>
        )),
      ])}
    </nav>
  );
}

/**
 * Render one preview page: sidebar links, the selected preview rendered under
 * its current control values, and a form to change them.
 *
 * The preview tree is always lowered with an action collector so handler ids
 * (`a0`, `a1`, …) are assigned consistently; pass `actions` to receive the
 * id → invoke map for a `do=` request.
 */
export function previewPage(
  groups: PreviewGroup[],
  selectedKey: string | null,
  rawArgs: Record<string, string> = {},
  actions?: Map<string, (value?: string) => void>,
): string {
  const preview = findPreview(groups, selectedKey) ?? groups[0]?.previews[0];
  const sidebar = sidebarNav(groups, preview?.key);
  const args = preview ? parseArgs(preview, rawArgs) : {};
  const fields: Record<string, string> = preview ? { preview: preview.key } : {};
  for (const [name, value] of Object.entries(args)) fields[name] = String(value);
  const collector = actions ?? new Map<string, (value?: string) => void>();
  const pane = (
    <main style={{ flex: '1 0 auto', position: 'relative' }}>
      <h1 style={{ fontSize: '1rem', marginBottom: '1lh' }}>{preview?.name ?? 'No previews'}</h1>
      {preview ? (
        toHtml(preview.view(args), { actions: collector, fields })
      ) : (
        <p>Nothing to show.</p>
      )}
      {preview?.controls ? controlsForm(preview, args) : null}
    </main>
  );
  const document = (
    <div style={{ display: 'flex', gap: '4ch' }}>
      {sidebar}
      {pane}
    </div>
  );
  return htmlPage(renderToHtml(document), { title: `fino ui — ${preview?.name ?? 'preview'}` });
}

let previewAppCounter = 0;

/**
 * Build the preview's HTTP application on `fino:ui/web`: the page loads once,
 * interactions POST JSON action envelopes (no navigation), the server invokes
 * the preview handler against its signals, and the updated tree returns over
 * SSE for in-place DOM patching. Only sidebar preview links navigate. Without
 * JavaScript, the same forms fall back to POST-redirect-GET.
 */
export function createPreviewApp(groups: PreviewGroup[] = catalogPreviews()): App {
  const instance = previewAppCounter++;
  const secret = `fino-preview-${instance}-${Math.random().toString(36).slice(2)}`;
  const app = new App();
  const routes = app
    .value('cookies', cookies())
    .value(
      'session',
      sessions({
        store: memoryCache({ namespace: `preview-sessions-${instance}` }),
        keys: [{ id: 'preview', secret: `${secret}-session` }],
        // The preview is a localhost dev tool served over plain http; a
        // Secure cookie would be dropped by the browser, minting a fresh
        // session per request and looping the live view's navigate fallback.
        cookieOptions: { secure: false },
        ttlMs: 24 * 36e5,
      }),
    )
    .layer(webUI({ store: new InMemoryViewStore(), secret, sweepIntervalMs: false }));

  const storyView = view({
    id: `fino:preview/preview-${instance}`,
    state: () => ({
      preview: new Signal(''),
      args: new Signal<Record<string, string>>({}),
    }),
    actions: {
      // One generic action per interaction: the preview tree is re-lowered to
      // rebuild the tree-order id map, then the submitted id's handler runs
      // against the preview's own signals.
      invoke: {
        handler({ state }, input) {
          const preview = findPreview(groups, state.preview.get() as string);
          if (preview === undefined) {
            throw new ViewActionError('action_not_found', { status: 404, recoverable: false });
          }
          const args = parseArgs(preview, state.args.get() as Record<string, string>);
          const collector = new Map<string, (value?: string) => void>();
          toHtml(preview.view(args), { actions: collector });
          const body = input as { do?: unknown; value?: unknown };
          const invoke = typeof body.do === 'string' ? collector.get(body.do) : undefined;
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
    render({ state, actions: refs }) {
      const preview = findPreview(groups, state.preview.get() as string) ?? groups[0]?.previews[0];
      if (preview === undefined) return <p>No previews</p>;
      const args = parseArgs(preview, state.args.get() as Record<string, string>);
      const collector = new Map<string, (value?: string) => void>();
      return (
        <main style={{ flex: '1 1 auto', position: 'relative' }}>
          <h1 style={{ fontSize: '1rem', marginBottom: '1rem' }}>{preview.name}</h1>
          {toHtml(preview.view(args), { actions: collector, action: refs.invoke })}
          {preview.controls ? controlsForm(preview, args, refs.configure) : null}
        </main>
      );
    },
  });

  routes.get('/').handle(async (ctx) => {
    const url = new URL(ctx.request.url);
    const preview = findPreview(groups, url.searchParams.get('preview')) ?? groups[0]?.previews[0];
    const rawArgs: Record<string, string> = {};
    for (const name of new Set(url.searchParams.keys())) {
      if (name === 'preview') continue;
      // A hidden 'false' precedes each checkbox, so the last value wins.
      const values = url.searchParams.getAll(name);
      rawArgs[name] = values[values.length - 1]!;
    }
    return page((inner) => (
      <html>
        <head>
          <meta charset="utf-8" />
          <title>{`fino ui — ${preview?.name ?? 'preview'}`}</title>
          <style>{rawHtml(PAGE_CSS)}</style>
        </head>
        <body>
          <div className="ui-root" style={{ display: 'flex', gap: '3rem' }}>
            {sidebarNav(groups, preview?.key)}
            <div style={{ flex: '1 1 auto' }}>
              {preview !== undefined ? (
                storyView.mount(inner, { preview: preview.key, args: rawArgs })
              ) : (
                <p>No previews</p>
              )}
            </div>
          </div>
          <script src={clientScriptPath()} defer />
        </body>
      </html>
    ))(ctx);
  });
  return app;
}

/**
 * Serve the preview over HTTP. The preview signals live in this process, so
 * every interaction round trip renders their current state.
 */
export function runPreviewHtml(
  options: { port?: number; hostname?: string; groups?: PreviewGroup[] } = {},
): ServeServer {
  const app = createPreviewApp(options.groups ?? catalogPreviews());
  return app.listen({
    port: options.port ?? 3080,
    hostname: options.hostname ?? '127.0.0.1',
  }) as ServeServer;
}
