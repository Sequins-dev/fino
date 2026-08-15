/** @jsxImportSource fino:ui */
/**
 * fino:ui/gallery — a storybook for the component catalog, in both render
 * targets.
 *
 * A story is a named view function; groups of stories describe the catalog.
 * The same stories drive two runners: `runGalleryTui()` renders a live,
 * navigable gallery in the terminal (sidebar + preview, arrow keys and mouse),
 * and `runGalleryHtml()` serves the gallery over HTTP with each story
 * transformed to HTML by `fino:ui/components/html`. Because both consume the
 * identical story trees, the gallery doubles as the dual-target conformance
 * surface: a component that renders sensibly in one target and not the other
 * is a bug you can see.
 *
 * ```ts no_run
 * import { runGalleryTui } from 'fino:ui/gallery';
 * await runGalleryTui();               // fino gallery.ts, in a terminal
 * ```
 *
 * ```ts no_run
 * import { runGalleryHtml } from 'fino:ui/gallery';
 * await runGalleryHtml({ port: 3080 }); // then open http://localhost:3080
 * ```
 */
import { Signal, createSignal, h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import {
  Box,
  Button,
  Checkbox,
  Clickable,
  ContextMenu,
  Details,
  FileTree,
  HStack,
  ListSelection,
  MenuList,
  Modal,
  Panel,
  RadioGroup,
  Rule,
  Select,
  Spacer,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  VStack,
  createDisclosure,
  createTextField,
  createTreeState,
  styles,
} from 'fino:ui/components';
import type { ExpanderPosition, FileTreeNode, MenuItem } from 'fino:ui/components';
import { render, getTerminalSize } from 'fino:tty/tui';
import { signal as processSignal } from 'fino:process';
import { PAGE_CSS, toHtml, htmlPage } from 'fino:ui/components/html';
import { rawHtml, renderToHtml } from 'fino:ui/html';
import type { ServeServer } from 'fino:net/http/server';
import { App, cookies, sessions } from 'fino:net/http/app';
import { memoryCache } from 'fino:cache';
import { ViewActionError, clientScriptPath, page, view, webUI } from 'fino:ui/web';
import { InMemoryViewStore } from 'fino:ui/web/state';

/** A value a story control can hold. */
export type ControlValue = string | number | boolean;

/**
 * An adjustable input a story exposes, so a component can be viewed under
 * different configurations without writing a story per configuration.
 */
export type Control =
  | { type: 'boolean'; label?: string; default: boolean }
  | { type: 'text'; label?: string; default: string }
  | { type: 'number'; label?: string; default: number; step?: number; min?: number; max?: number }
  | { type: 'select'; label?: string; options: string[]; default: string };

/** The current values of a story's controls, passed to its view. */
export type StoryArgs = Record<string, ControlValue>;

/**
 * One named component demonstration. `view` receives the current control
 * values; a story without controls receives an empty object.
 */
export interface Story {
  key: string;
  name: string;
  controls?: Record<string, Control>;
  view: (args: StoryArgs) => VNode;
}

/** A titled group of stories. */
export interface StoryGroup {
  title: string;
  stories: Story[];
}

/** The default argument values a story's controls declare. */
export function defaultArgs(story: Story): StoryArgs {
  const args: StoryArgs = {};
  for (const [name, control] of Object.entries(story.controls ?? {})) {
    args[name] = control.default;
  }
  return args;
}

function clampNumber(control: Extract<Control, { type: 'number' }>, value: number): number {
  let out = value;
  if (control.max !== undefined) out = Math.min(out, control.max);
  if (control.min !== undefined) out = Math.max(out, control.min);
  return out;
}

/** Parse control values from strings (query params, CLI args). */
export function parseArgs(story: Story, raw: Record<string, string>): StoryArgs {
  const args = defaultArgs(story);
  for (const [name, control] of Object.entries(story.controls ?? {})) {
    const value = raw[name];
    if (value === undefined) continue;
    if (control.type === 'boolean') args[name] = value === 'true' || value === 'on';
    else if (control.type === 'number') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) args[name] = clampNumber(control, parsed);
    } else if (control.type === 'select') {
      if (control.options.includes(value)) args[name] = value;
    } else args[name] = value;
  }
  return args;
}

function formsGroup(): StoryGroup {
  const checked = createSignal(true);
  const radio = createSignal('b');
  const power = createSignal(false);
  const text = createTextField('hello');
  return {
    title: 'Forms',
    stories: [
      {
        key: 'buttons',
        name: 'Button',
        controls: {
          label: { type: 'text', default: 'Save' },
          disabled: { type: 'boolean', default: false },
          focused: { type: 'boolean', default: false },
        },
        view: (args) => (
          <Button
            label={String(args.label)}
            disabled={args.disabled === true}
            focused={args.focused === true}
            onClick={() => {}}
          />
        ),
      },
      {
        key: 'checkbox',
        name: 'Checkbox',
        view: () => (
          <VStack>
            <Checkbox
              checked={checked.get()}
              label="Notifications"
              onChange={(next) => checked.set(next)}
            />
            <Checkbox checked={false} label="Disabled" disabled />
          </VStack>
        ),
      },
      {
        key: 'radio',
        name: 'RadioGroup',
        view: () => (
          <RadioGroup
            value={radio.get()}
            onChange={(key) => radio.set(key)}
            options={[
              { key: 'a', label: 'Alpha' },
              { key: 'b', label: 'Beta' },
              { key: 'c', label: 'Gamma' },
            ]}
          />
        ),
      },
      {
        key: 'switch',
        name: 'Switch',
        view: () => (
          <VStack>
            <Switch on={power.get()} label="Power" onChange={(next) => power.set(next)} />
            <Switch on label="Locked on" />
          </VStack>
        ),
      },
      {
        key: 'text-input',
        name: 'TextInput',
        view: () => (
          <VStack gap={1}>
            <TextInput
              value={text.value.get()}
              caret={text.caret.get()}
              selection={text.selection.get()}
              focused
              onChange={text.set}
            />
            <TextInput value="" placeholder="Type here…" />
          </VStack>
        ),
      },
    ],
  };
}

function dataGroup(): StoryGroup {
  const tree = createTreeState(['src']);
  const picked = createSignal<string | null>('a');
  const row = createSignal(0);
  const nodes: FileTreeNode[] = [
    {
      key: 'src',
      label: 'src',
      children: [
        { key: 'a', label: 'main.ts' },
        { key: 'theme', label: 'theme.json' },
        { key: 'lib', label: 'lib', children: [{ key: 'b', label: 'util.js' }] },
        { key: 'logo', label: 'logo.png' },
        { key: 'data', label: 'data.bin' },
      ],
    },
    { key: 'docs', label: 'docs', children: [{ key: 'guide', label: 'guide.md' }] },
    { key: 'readme', label: 'README.md' },
    { key: 'lock', label: 'deps.lock' },
  ];
  return {
    title: 'Data views',
    stories: [
      {
        key: 'file-tree',
        name: 'FileTree',
        view: () => (
          <FileTree
            id="gallery-tree"
            nodes={nodes}
            expanded={tree.expanded.get()}
            selectedKey={picked.get()}
            onToggle={tree.toggle}
            onSelect={(key) => picked.set(key)}
          />
        ),
      },
      {
        key: 'table',
        name: 'Table',
        view: () => (
          <Table
            id="gallery-table"
            columns={[
              { key: 'name', header: 'Name' },
              { key: 'size', header: 'Size', align: 'end' },
            ]}
            rows={[
              { name: 'a.ts', size: '120' },
              { name: 'lib/b.ts', size: '48' },
              { name: 'README.md', size: '1024' },
            ]}
            selectedIndex={row.get()}
            onSelectRow={(index) => row.set(index)}
          />
        ),
      },
    ],
  };
}

function layoutGroup(): StoryGroup {
  return {
    title: 'Layout',
    stories: [
      {
        key: 'panel',
        name: 'Panel',
        controls: {
          title: { type: 'text', default: 'Session' },
          border: {
            type: 'select',
            options: ['single', 'heavy', 'double', 'ascii'],
            default: 'single',
          },
          rounded: { type: 'boolean', default: false },
          width: { type: 'number', default: 30, step: 2, min: 12, max: 60 },
        },
        view: (args) => (
          <Panel
            title={String(args.title)}
            border={args.border as never}
            rounded={args.rounded === true || args.rounded === 'true'}
            width={Number(args.width)}
          >
            <Text>Bordered content with a title.</Text>
            <Rule />
            <HStack gap={1} justify="between">
              <Text style={[styles.muted]}>left</Text>
              <Text style={[styles.accent]}>right</Text>
            </HStack>
          </Panel>
        ),
      },
      {
        key: 'stacks',
        name: 'Stacks & flex',
        view: () => (
          <VStack gap={1} width={34}>
            <HStack gap={1}>
              <Text style={[styles.inverse]}> fixed </Text>
              <Spacer flex={1} />
              <Text style={[styles.inverse]}> end </Text>
            </HStack>
            <HStack gap={1}>
              <Box border grow={1} padding={0}>
                <Text align="center">grow 1</Text>
              </Box>
              <Box border grow={2}>
                <Text align="center">grow 2</Text>
              </Box>
            </HStack>
          </VStack>
        ),
      },
    ],
  };
}

function disclosureGroup(): StoryGroup {
  const details = createDisclosure(true);
  const tab = createSignal('one');
  return {
    title: 'Disclosure',
    stories: [
      {
        key: 'details',
        name: 'Details',
        controls: {
          expander: { type: 'select', options: ['start', 'end', 'none'], default: 'start' },
        },
        view: (args) => (
          <Details
            title="Advanced options"
            open={details.open.get()}
            expander={args.expander as ExpanderPosition}
            onToggle={(next) => details.set(next)}
          >
            <Text>Hidden until expanded.</Text>
            <Text style={[styles.muted]}>Click the summary bar to toggle.</Text>
          </Details>
        ),
      },
      {
        key: 'tabs',
        name: 'Tabs',
        view: () => (
          <Tabs
            value={tab.get()}
            onChange={(key) => tab.set(key)}
            items={[
              { key: 'one', label: 'Overview' },
              { key: 'two', label: 'Details' },
              { key: 'three', label: 'Raw' },
            ]}
          >
            <Text>{`Active panel: ${tab.get()}`}</Text>
          </Tabs>
        ),
      },
    ],
  };
}

function overlayGroup(): StoryGroup {
  const modal = createDisclosure(false);
  const select = createDisclosure(false);
  const model = createSignal<string | null>(null);
  const menu = createDisclosure(false);
  const menuAt = createSignal({ x: 4, y: 1 });
  return {
    title: 'Menus & overlays',
    stories: [
      {
        key: 'menu-list',
        name: 'MenuList',
        view: () => {
          const items: MenuItem[] = [
            { kind: 'header', label: 'Models' },
            { key: 'fast', label: 'fast-1', detail: 'cheap' },
            { key: 'smart', label: 'smart-2', detail: 'slow' },
            { kind: 'separator' },
            { key: 'off', label: 'disabled', disabled: true },
          ];
          return <MenuList items={items} selectedKey="smart" />;
        },
      },
      {
        key: 'select',
        name: 'Select',
        view: () => (
          <VStack gap={1} width={26}>
            <Select
              id="gallery-select"
              value={model.get()}
              open={select.open.get()}
              onOpenChange={(next) => select.set(next)}
              onChange={(key) => model.set(key)}
              placeholder="Pick a model"
              options={[
                { key: 'fast', label: 'fast-1' },
                { key: 'smart', label: 'smart-2' },
              ]}
            />
            <Text style={[styles.muted]}>Click the trigger to open.</Text>
          </VStack>
        ),
      },
      {
        key: 'modal',
        name: 'Modal',
        view: () => (
          <VStack gap={1}>
            <Button label="Open modal" onClick={() => modal.set(true)} />
            <Text style={[styles.muted]}>Esc or the backdrop story text dims.</Text>
            {modal.open.get() ? (
              <Modal title="Confirm" onDismiss={() => modal.set(false)}>
                <Text>Delete this session?</Text>
                <Text style={[styles.dim]}>esc cancels</Text>
              </Modal>
            ) : null}
          </VStack>
        ),
      },
      {
        key: 'context-menu',
        name: 'ContextMenu',
        view: () => (
          <VStack
            gap={1}
            onMouse={(event) => {
              if (event.action === 'press') menuAt.set({ x: event.x, y: event.y });
              return false;
            }}
          >
            <Button label="Open menu" onClick={() => menu.set(true)} />
            {menu.open.get() ? (
              <ContextMenu
                at={menuAt.get()}
                items={[
                  { key: 'rename', label: 'Rename' },
                  { key: 'archive', label: 'Archive' },
                  { key: 'delete', label: 'Delete' },
                ]}
                onSelect={() => menu.set(false)}
                onDismiss={() => menu.set(false)}
              />
            ) : null}
          </VStack>
        ),
      },
    ],
  };
}

/**
 * The built-in stories for the component catalog. Each call creates fresh
 * story state, so two galleries never share signals.
 */
export function catalogStories(): StoryGroup[] {
  return [layoutGroup(), formsGroup(), disclosureGroup(), overlayGroup(), dataGroup()];
}

function storyItems(groups: StoryGroup[]): MenuItem[] {
  const items: MenuItem[] = [];
  for (const group of groups) {
    items.push({ kind: 'header', label: group.title });
    for (const story of group.stories) items.push({ key: story.key, label: story.name });
  }
  return items;
}

function findStory(groups: StoryGroup[], key: string | null): Story | undefined {
  for (const group of groups) {
    for (const story of group.stories) if (story.key === key) return story;
  }
  return undefined;
}

interface ControlsPaneProps {
  story: Story;
  args: StoryArgs;
  onChange: (name: string, value: ControlValue) => void;
}

function ControlsPane(props: ControlsPaneProps): VNode {
  const { story, args, onChange } = props;
  const entries = Object.entries(story.controls ?? {});
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
 * Run the gallery as a live fullscreen terminal app. Arrow keys and clicks
 * choose a story, the preview stays interactive, control rows adjust the
 * story's configuration in place (click text controls to focus, then type),
 * and `q` quits.
 */
export async function runGalleryTui(groups: StoryGroup[] = catalogStories()): Promise<void> {
  const size = createSignal(getTerminalSize());
  const selection = new ListSelection({ maxRows: Math.max(4, size.get().height - 6) });
  selection.setItems(storyItems(groups));
  const winch = processSignal('SIGWINCH').subscribe(() => {
    const next = getTerminalSize();
    selection.setMaxRows(Math.max(4, next.height - 6));
    size.set(next);
  });
  const selected = createSignal<string | null>(selection.selectedKey);
  const argsByStory = new Map<string, ReturnType<typeof createSignal<StoryArgs>>>();

  function argsFor(story: Story): ReturnType<typeof createSignal<StoryArgs>> {
    let existing = argsByStory.get(story.key);
    if (!existing) {
      existing = createSignal<StoryArgs>(defaultArgs(story));
      argsByStory.set(story.key, existing);
    }
    return existing;
  }

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const view = (): VNode => {
    const story = findStory(groups, selected.get());
    const args = story ? argsFor(story) : null;
    return (
      <HStack grow={1} gap={1} height={size.get().height}>
        <Panel title="Stories" width={24} height={size.get().height}>
          <MenuList
            id="stories"
            items={selection.items as MenuItem[]}
            selectedKey={selected.get()}
            top={selection.top}
            maxRows={selection.maxRows}
            onSelect={(key) => {
              selection.selectKey(key);
              selected.set(key);
            }}
          />
        </Panel>
        <Panel title={story?.name ?? '—'} grow={1} height={size.get().height}>
          <Box grow={1} direction="column">
            {story && args ? (
              story.view(args.get())
            ) : (
              <Text style={[styles.muted]}>No story selected</Text>
            )}
          </Box>
          {story && args && story.controls ? (
            <ControlsPane
              story={story}
              args={args.get()}
              onChange={(name, value) => args.set({ ...args.get(), [name]: value })}
            />
          ) : null}
          <Text style={[styles.dim]}>↑↓ story · q quit</Text>
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

function controlsForm(story: Story, args: StoryArgs, action?: unknown): VNode {
  // With a fino:ui/web action descriptor the form posts as a JSON envelope
  // and the page updates over SSE; the client's change listener handles
  // auto-submit. Without one, plain GET forms with inline resubmission.
  const change: Props = action === undefined ? { onchange: 'this.form.submit()' } : {};
  const rows = Object.entries(story.controls ?? {}).map(([name, control]) => {
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
          h('option', { value: option, selected: option === value }, option),
        ),
      );
    } else if (control.type === 'number') {
      field = h('input', {
        type: 'number',
        name,
        value: String(value),
        step: String(control.step ?? 1),
        ...(control.min !== undefined ? { min: String(control.min) } : {}),
        ...(control.max !== undefined ? { max: String(control.max) } : {}),
        ...change,
      });
    } else {
      field = h('input', { type: 'text', name, value: String(value), ...change });
    }
    return h(
      'label',
      { style: { display: 'flex', gap: '1ch', alignItems: 'center' } },
      h('span', { style: { opacity: '0.55', minWidth: '10ch' } }, label),
      field,
    );
  });
  const formProps: Props =
    action === undefined ? { method: 'get' } : { action, method: 'post', 'data-fi-change': '' };
  formProps.style = { display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '1rem' };
  return h(
    'form',
    formProps,
    h('div', { style: { opacity: '0.55', fontWeight: 'bold' } }, 'controls'),
    action === undefined ? h('input', { type: 'hidden', name: 'story', value: story.key }) : null,
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

function sidebarNav(groups: StoryGroup[], activeKey: string | undefined): VNode {
  return h(
    'nav',
    { style: { minWidth: '12rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' } },
    ...groups.flatMap((group) => [
      h('div', { style: { opacity: '0.55', marginTop: '0.75rem' } }, group.title),
      ...group.stories.map((entry) =>
        h(
          'a',
          {
            href: `?story=${entry.key}`,
            style: entry.key === activeKey ? { fontWeight: 'bold' } : {},
          },
          entry.name,
        ),
      ),
    ]),
  );
}

/**
 * Render one gallery page: sidebar links, the selected story rendered under
 * its current control values, and a form to change them.
 *
 * The story tree is always lowered with an action collector so handler ids
 * (`a0`, `a1`, …) are assigned consistently; pass `actions` to receive the
 * id → invoke map for a `do=` request.
 */
export function galleryPage(
  groups: StoryGroup[],
  selectedKey: string | null,
  rawArgs: Record<string, string> = {},
  actions?: Map<string, (value?: string) => void>,
): string {
  const story = findStory(groups, selectedKey) ?? groups[0]?.stories[0];
  const sidebar = sidebarNav(groups, story?.key);
  const args = story ? parseArgs(story, rawArgs) : {};
  const fields: Record<string, string> = story ? { story: story.key } : {};
  for (const [name, value] of Object.entries(args)) fields[name] = String(value);
  const collector = actions ?? new Map<string, (value?: string) => void>();
  const preview = h(
    'main',
    { style: { flex: '1 0 auto', position: 'relative' } },
    h('h1', { style: { fontSize: '1rem', marginBottom: '1lh' } }, story?.name ?? 'No stories'),
    story
      ? toHtml(story.view(args), { actions: collector, fields })
      : h('p', null, 'Nothing to show.'),
    story?.controls ? controlsForm(story, args) : null,
  );
  const page = h('div', { style: { display: 'flex', gap: '4ch' } }, sidebar, preview);
  return htmlPage(renderToHtml(page), { title: `fino ui — ${story?.name ?? 'gallery'}` });
}

let galleryAppCounter = 0;

/**
 * Build the gallery's HTTP application on `fino:ui/web`: the page loads once,
 * interactions POST JSON action envelopes (no navigation), the server invokes
 * the story handler against its signals, and the updated tree returns over
 * SSE for in-place DOM patching. Only sidebar story links navigate. Without
 * JavaScript, the same forms fall back to POST-redirect-GET.
 */
export function createGalleryApp(groups: StoryGroup[] = catalogStories()): App {
  const instance = galleryAppCounter++;
  const secret = `fino-gallery-${instance}-${Math.random().toString(36).slice(2)}`;
  const app = new App();
  const routes = app
    .value('cookies', cookies())
    .value(
      'session',
      sessions({
        store: memoryCache({ namespace: `gallery-sessions-${instance}` }),
        keys: [{ id: 'gallery', secret: `${secret}-session` }],
        // The gallery is a localhost dev tool served over plain http; a
        // Secure cookie would be dropped by the browser, minting a fresh
        // session per request and looping the live view's navigate fallback.
        cookieOptions: { secure: false },
        ttlMs: 24 * 36e5,
      }),
    )
    .layer(webUI({ store: new InMemoryViewStore(), secret, sweepIntervalMs: false }));

  const storyView = view({
    id: `fino:gallery/story-${instance}`,
    state: () => ({
      story: new Signal(''),
      args: new Signal<Record<string, string>>({}),
    }),
    actions: {
      // One generic action per interaction: the story tree is re-lowered to
      // rebuild the tree-order id map, then the submitted id's handler runs
      // against the story's own signals.
      invoke: {
        handler({ state }, input) {
          const story = findStory(groups, state.story.get() as string);
          if (story === undefined) {
            throw new ViewActionError('action_not_found', { status: 404, recoverable: false });
          }
          const args = parseArgs(story, state.args.get() as Record<string, string>);
          const collector = new Map<string, (value?: string) => void>();
          toHtml(story.view(args), { actions: collector });
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
      const story = findStory(groups, state.story.get() as string) ?? groups[0]?.stories[0];
      if (story === undefined) return h('p', null, 'No stories');
      const args = parseArgs(story, state.args.get() as Record<string, string>);
      const collector = new Map<string, (value?: string) => void>();
      return h(
        'main',
        { style: { flex: '1 1 auto', position: 'relative' } },
        h('h1', { style: { fontSize: '1rem', marginBottom: '1rem' } }, story.name),
        toHtml(story.view(args), { actions: collector, action: refs.invoke }),
        story.controls ? controlsForm(story, args, refs.configure) : null,
      );
    },
  });

  routes.get('/').handle(async (ctx) => {
    const url = new URL(ctx.request.url);
    const story = findStory(groups, url.searchParams.get('story')) ?? groups[0]?.stories[0];
    const rawArgs: Record<string, string> = {};
    for (const name of new Set(url.searchParams.keys())) {
      if (name === 'story') continue;
      // A hidden 'false' precedes each checkbox, so the last value wins.
      const values = url.searchParams.getAll(name);
      rawArgs[name] = values[values.length - 1]!;
    }
    return page((inner) =>
      h(
        'html',
        null,
        h(
          'head',
          null,
          h('meta', { charset: 'utf-8' }),
          h('title', null, `fino ui — ${story?.name ?? 'gallery'}`),
          h('style', null, rawHtml(PAGE_CSS)),
        ),
        h(
          'body',
          null,
          h(
            'div',
            { className: 'ui-root', style: { display: 'flex', gap: '3rem' } },
            sidebarNav(groups, story?.key),
            h(
              'div',
              { style: { flex: '1 1 auto' } },
              story !== undefined
                ? storyView.mount(inner, { story: story.key, args: rawArgs })
                : h('p', null, 'No stories'),
            ),
          ),
          h('script', { src: clientScriptPath(), defer: true }),
        ),
      ),
    )(ctx);
  });
  return app;
}

/**
 * Serve the gallery over HTTP. The story signals live in this process, so
 * every interaction round trip renders their current state.
 */
export function runGalleryHtml(
  options: { port?: number; hostname?: string; groups?: StoryGroup[] } = {},
): ServeServer {
  const app = createGalleryApp(options.groups ?? catalogStories());
  return app.listen({
    port: options.port ?? 3080,
    hostname: options.hostname ?? '127.0.0.1',
  }) as ServeServer;
}
