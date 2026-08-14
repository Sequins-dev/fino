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
import { createSignal, h } from 'fino:ui';
import type { VNode } from 'fino:ui';
import {
  Box,
  Button,
  Checkbox,
  Clickable,
  ContextMenu,
  Details,
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
  Tabs,
  Text,
  TextInput,
  VStack,
  createDisclosure,
  styles,
} from 'fino:ui/components';
import type { MenuItem } from 'fino:ui/components';
import { render, getTerminalSize } from 'fino:tty/tui';
import { toHtml, htmlPage } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';
import { serveHttp } from 'fino:net/http/server';
import type { ServeServer } from 'fino:net/http/server';

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
  const text = createSignal('hello');
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
            <TextInput value={text.get()} focused caret={text.get().length} />
            <TextInput value="" placeholder="Type here…" />
          </VStack>
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
            options: ['single', 'round', 'heavy', 'double', 'ascii'],
            default: 'single',
          },
          width: { type: 'number', default: 30, step: 2, min: 12, max: 60 },
        },
        view: (args) => (
          <Panel
            title={String(args.title)}
            border={args.border as never}
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
        view: () => (
          <Details
            title="Advanced options"
            open={details.open.get()}
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
          <VStack gap={1}>
            <Button label="Open menu" onClick={() => menu.set(true)} />
            {menu.open.get() ? (
              <ContextMenu
                at={{ x: 4, y: 1 }}
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
  return [layoutGroup(), formsGroup(), disclosureGroup(), overlayGroup()];
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
  const size = getTerminalSize();
  const selection = new ListSelection({ maxRows: Math.max(4, size.height - 6) });
  selection.setItems(storyItems(groups));
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
      <HStack grow={1} gap={1} height={size.height}>
        <Panel title="Stories" width={24} height={size.height}>
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
        <Panel title={story?.name ?? '—'} grow={1} height={size.height}>
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
        app.stop();
        resolveDone();
        return;
      }
      if (selection.handleKey(event)) selected.set(selection.selectedKey);
    },
  });
  await done;
}

function controlsForm(story: Story, args: StoryArgs): VNode {
  // Controls re-render on change; the Apply button stays as the no-JS path.
  const resubmit = 'this.form.submit()';
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
          onchange: resubmit,
        }),
      );
    } else if (control.type === 'select') {
      field = h(
        'select',
        { name, onchange: resubmit },
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
        onchange: resubmit,
      });
    } else {
      field = h('input', { type: 'text', name, value: String(value), onchange: resubmit });
    }
    return h(
      'label',
      { style: { display: 'flex', gap: '1ch', alignItems: 'center' } },
      h('span', { style: { opacity: '0.55', minWidth: '10ch' } }, label),
      field,
    );
  });
  return h(
    'form',
    {
      method: 'get',
      style: { display: 'flex', flexDirection: 'column', gap: '0.25lh', marginTop: '1lh' },
    },
    h('div', { style: { opacity: '0.55', fontWeight: 'bold' } }, 'controls'),
    h('input', { type: 'hidden', name: 'story', value: story.key }),
    ...rows,
    h(
      'button',
      {
        type: 'submit',
        style: {
          alignSelf: 'flex-start',
          border: '1px solid var(--tui-border)',
          padding: '0 1ch',
          cursor: 'pointer',
        },
      },
      'Apply',
    ),
  );
}

/**
 * Render one gallery page: sidebar links, the selected story rendered under
 * its current control values, and a form to change them.
 */
export function galleryPage(
  groups: StoryGroup[],
  selectedKey: string | null,
  rawArgs: Record<string, string> = {},
): string {
  const story = findStory(groups, selectedKey) ?? groups[0]?.stories[0];
  const sidebar = h(
    'nav',
    { style: { minWidth: '18ch', display: 'flex', flexDirection: 'column', gap: '0.25lh' } },
    ...groups.flatMap((group) => [
      h('div', { style: { opacity: '0.55', marginTop: '0.5lh' } }, group.title),
      ...group.stories.map((entry) =>
        h(
          'a',
          {
            href: `?story=${entry.key}`,
            style: entry.key === story?.key ? { fontWeight: 'bold' } : {},
          },
          entry.name,
        ),
      ),
    ]),
  );
  const args = story ? parseArgs(story, rawArgs) : {};
  const preview = h(
    'main',
    { style: { flex: '1 0 auto', position: 'relative' } },
    h('h1', { style: { fontSize: '1rem', marginBottom: '1lh' } }, story?.name ?? 'No stories'),
    story ? toHtml(story.view(args)) : h('p', null, 'Nothing to show.'),
    story?.controls ? controlsForm(story, args) : null,
  );
  const page = h('div', { style: { display: 'flex', gap: '4ch' } }, sidebar, preview);
  return htmlPage(renderToHtml(page), { title: `fino ui — ${story?.name ?? 'gallery'}` });
}

/**
 * Serve the gallery over HTTP. Every request re-renders the requested story,
 * so signal-driven stories show their current state.
 */
export function runGalleryHtml(
  options: { port?: number; hostname?: string; groups?: StoryGroup[] } = {},
): ServeServer {
  const groups = options.groups ?? catalogStories();
  return serveHttp(
    { port: options.port ?? 3080, hostname: options.hostname ?? '127.0.0.1' },
    (request) => {
      const url = new URL(request.url);
      const key = url.searchParams.get('story');
      const rawArgs: Record<string, string> = {};
      for (const name of new Set(url.searchParams.keys())) {
        if (name === 'story') continue;
        // A hidden 'false' precedes each checkbox, so the last value wins.
        const values = url.searchParams.getAll(name);
        rawArgs[name] = values[values.length - 1]!;
      }
      return new Response(galleryPage(groups, key, rawArgs), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  );
}
