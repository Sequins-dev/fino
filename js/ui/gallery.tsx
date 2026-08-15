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
  Accordion,
  Badge,
  BarChart,
  Blockquote,
  Bold,
  Box,
  Breadcrumbs,
  Button,
  Calendar,
  Card,
  Checkbox,
  Clickable,
  Code,
  ColorPicker,
  ComboBox,
  ContextMenu,
  DatePicker,
  Details,
  DigitalClock,
  EmptyState,
  Expander,
  Field,
  Fieldset,
  FileTree,
  FloatingActionBar,
  HStack,
  Heading,
  HoverCard,
  ICONS,
  Icon,
  IconButton,
  InlineCode,
  Italic,
  KeyHint,
  Link,
  LineChart,
  List,
  ListSelection,
  MenuList,
  Modal,
  NumberInput,
  Pagination,
  Panel,
  Popover,
  ProgressBar,
  RadioGroup,
  Rule,
  Select,
  Slider,
  Spacer,
  Spinner,
  Stat,
  StatusDot,
  Steps,
  Switch,
  Table,
  Tabs,
  Tag,
  TagGroup,
  Text,
  TextArea,
  TextInput,
  TimePicker,
  Timeline,
  Toast,
  ToastStack,
  Tooltip,
  VStack,
  VirtualList,
  VirtualScroll,
  createAccordion,
  createDisclosure,
  createTextArea,
  createTextField,
  createTreeState,
  styles,
} from 'fino:ui/components';
import type {
  ComboBoxOption,
  ExpanderPosition,
  FileTreeNode,
  MenuItem,
  Series,
  StatusDotStatus,
  StatusVariant,
  ToneVariant,
  Trend,
} from 'fino:ui/components';
import { render, getTerminalSize, copyToClipboard } from 'fino:tty/tui';
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

const COMBO_OPTIONS: ComboBoxOption[] = [
  { key: 'js', label: 'JavaScript' },
  { key: 'ts', label: 'TypeScript' },
  { key: 'py', label: 'Python' },
  { key: 'rs', label: 'Rust' },
  { key: 'go', label: 'Go' },
];

function formsGroup(): StoryGroup {
  const checked = createSignal(true);
  const radio = createSignal('b');
  const power = createSignal(false);
  const text = createTextField('hello');
  const password = createTextField('');
  const notes = createTextArea('Line one\nLine two');
  const age = createSignal(28);
  const volume = createSignal(40);
  const combo = createTextField('');
  const comboOpen = createSignal(false);
  const comboActive = createSignal<string | null>(null);
  const comboPicked = createSignal<string | null>(null);
  const starred = createSignal(false);
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
      {
        key: 'password',
        name: 'TextInput (password)',
        view: () => (
          <VStack gap={1}>
            <TextInput
              value={password.value.get()}
              caret={password.caret.get()}
              selection={password.selection.get()}
              password
              focused
              onChange={password.set}
            />
            <Text style={[styles.muted]}>{`real value: ${password.value.get() || '(empty)'}`}</Text>
          </VStack>
        ),
      },
      {
        key: 'text-area',
        name: 'TextArea',
        view: () => (
          <TextArea
            value={notes.value.get()}
            caret={notes.caret.get()}
            selection={notes.selection.get()}
            rows={4}
            focused
            onChange={notes.set}
          />
        ),
      },
      {
        key: 'field',
        name: 'Field',
        controls: {
          required: { type: 'boolean', default: true },
          error: { type: 'text', default: '' },
        },
        view: (args) => (
          <Field
            id="field-email"
            htmlFor="field-email-input"
            label="Email"
            hint="We only use this for release notes."
            error={String(args.error).length > 0 ? String(args.error) : undefined}
            required={args.required === true}
          >
            <TextInput id="field-email-input" value="" placeholder="you@example.com" />
          </Field>
        ),
      },
      {
        key: 'fieldset',
        name: 'Fieldset',
        view: () => (
          <Fieldset legend="Preferences" width={30}>
            <Checkbox
              checked={checked.get()}
              label="Product updates"
              onChange={(next) => checked.set(next)}
            />
            <Checkbox checked={false} label="Marketing" disabled />
          </Fieldset>
        ),
      },
      {
        key: 'number-input',
        name: 'NumberInput',
        view: () => (
          <VStack gap={1}>
            <NumberInput value={age.get()} min={0} max={120} onChange={(next) => age.set(next)} />
            <Text style={[styles.muted]}>{`age: ${age.get()}`}</Text>
          </VStack>
        ),
      },
      {
        key: 'slider',
        name: 'Slider',
        controls: {
          orientation: {
            type: 'select',
            options: ['horizontal', 'vertical'],
            default: 'horizontal',
          },
        },
        view: (args) => (
          <VStack gap={1}>
            <Slider
              id="gallery-slider"
              value={volume.get()}
              orientation={args.orientation as 'horizontal' | 'vertical'}
              onChange={(next) => volume.set(next)}
            />
            <Text style={[styles.muted]}>{`volume: ${volume.get()}`}</Text>
          </VStack>
        ),
      },
      {
        key: 'combobox',
        name: 'ComboBox',
        view: () => (
          <VStack gap={1} width={26}>
            <ComboBox
              id="gallery-combo"
              value={combo.value.get()}
              options={COMBO_OPTIONS}
              open={comboOpen.get()}
              activeKey={comboActive.get()}
              onActiveChange={(key) => comboActive.set(key)}
              onOpenChange={(open) => comboOpen.set(open)}
              onInput={combo.set}
              onSelect={(key) => {
                comboPicked.set(key);
                const picked = COMBO_OPTIONS.find((option) => option.key === key);
                if (picked) combo.set(picked.label);
              }}
            />
            <Text style={[styles.muted]}>{`picked: ${comboPicked.get() ?? '—'}`}</Text>
          </VStack>
        ),
      },
      {
        key: 'icon-button',
        name: 'IconButton',
        view: () => (
          <HStack gap={1}>
            <IconButton
              id="gallery-icon-button"
              icon={starred.get() ? 'lock' : 'file'}
              label={starred.get() ? 'Unstar' : 'Star'}
              onClick={() => starred.set(!starred.get())}
            />
            <Text style={[styles.muted]}>{starred.get() ? 'starred' : 'not starred'}</Text>
          </HStack>
        ),
      },
    ],
  };
}

const TONE_VARIANTS: ToneVariant[] = ['accent', 'muted', 'danger', 'success', 'warning'];

function indicatorsGroup(): StoryGroup {
  const tagLabels = ['alpha', 'beta', 'gamma', 'delta'];
  const tagColors: Record<string, ToneVariant> = {
    alpha: 'accent',
    beta: 'success',
    gamma: 'warning',
    delta: 'muted',
  };
  const tags = createSignal(tagLabels);
  return {
    title: 'Indicators',
    stories: [
      {
        key: 'badge',
        name: 'Badge',
        controls: {
          label: { type: 'text', default: 'beta' },
          variant: { type: 'select', options: [...TONE_VARIANTS], default: 'accent' },
        },
        view: (args) => (
          <VStack gap={1}>
            <Badge label={String(args.label)} variant={args.variant as ToneVariant} />
            <HStack gap={1}>
              {TONE_VARIANTS.map((variant) => (
                <Badge key={variant} label={variant} variant={variant} />
              ))}
            </HStack>
          </VStack>
        ),
      },
      {
        key: 'icons',
        name: 'Icon',
        view: () => (
          <Box direction="row" wrap gap={2} width={54}>
            {Object.keys(ICONS).map((name) => (
              <HStack key={name} gap={1} width={16}>
                <Icon name={name} label={name} />
                <Text style={[styles.muted]}>{name}</Text>
              </HStack>
            ))}
          </Box>
        ),
      },
      {
        key: 'key-hint',
        name: 'KeyHint',
        controls: {
          separator: { type: 'text', default: '·' },
        },
        view: (args) => (
          <KeyHint
            separator={String(args.separator)}
            keys={[
              { key: 'y', label: 'approve' },
              { key: 'n', label: 'reject' },
              { key: 'q', label: 'quit' },
            ]}
          />
        ),
      },
      {
        key: 'tags',
        name: 'Tag & TagGroup',
        view: () => (
          <VStack gap={1}>
            <TagGroup>
              {tags.get().map((label) => (
                <Tag
                  key={label}
                  id={`tag:${label}`}
                  label={label}
                  color={tagColors[label]}
                  onRemove={() => tags.set(tags.get().filter((tag) => tag !== label))}
                />
              ))}
            </TagGroup>
            <HStack gap={1}>
              <Button label="Reset" onClick={() => tags.set(tagLabels)} />
              <Text style={[styles.muted]}>{`${tags.get().length} tags`}</Text>
            </HStack>
          </VStack>
        ),
      },
    ],
  };
}

function feedbackGroup(): StoryGroup {
  const toasts = createSignal<Array<{ id: string; message: string; variant?: StatusVariant }>>([]);
  let toastId = 0;
  const pushToast = (variant: StatusVariant, message: string): void => {
    toastId += 1;
    toasts.set([
      ...toasts.get(),
      { id: String(toastId), message: `${message} #${toastId}`, variant },
    ]);
  };
  return {
    title: 'Feedback',
    stories: [
      {
        key: 'spinner',
        name: 'Spinner',
        controls: {
          tick: { type: 'number', default: 0, min: 0 },
        },
        view: (args) => (
          <HStack gap={1}>
            <Spinner tick={Number(args.tick)} />
            <Text style={[styles.muted]}>{`tick ${String(args.tick)}`}</Text>
          </HStack>
        ),
      },
      {
        key: 'progress',
        name: 'ProgressBar',
        controls: {
          value: { type: 'number', default: 40, step: 10, min: 0, max: 100 },
          showPercent: { type: 'boolean', default: true },
        },
        view: (args) => (
          <ProgressBar
            value={Number(args.value) / 100}
            width={24}
            showPercent={args.showPercent === true}
          />
        ),
      },
      {
        key: 'toasts',
        name: 'Toast & ToastStack',
        view: () => (
          <VStack gap={1}>
            <HStack gap={1}>
              <Button label="Info" onClick={() => pushToast('info', 'Heads up')} />
              <Button label="Success" onClick={() => pushToast('success', 'Saved')} />
              <Button label="Danger" onClick={() => pushToast('danger', 'Failed')} />
              <Button label="Clear" onClick={() => toasts.set([])} />
            </HStack>
            <Toast message="Standalone toast" variant="warning" />
            <Text style={[styles.muted]}>{`${toasts.get().length} stacked`}</Text>
            <ToastStack toasts={toasts.get()} />
          </VStack>
        ),
      },
    ],
  };
}

function navigationGroup(): StoryGroup {
  const crumbTrail = [
    { key: 'root', label: '~' },
    { key: 'src', label: 'src' },
    { key: 'ui', label: 'ui' },
    { key: 'gallery', label: 'gallery.tsx' },
  ];
  const crumb = createSignal('gallery');
  const pageAt = createSignal(1);
  return {
    title: 'Navigation',
    stories: [
      {
        key: 'breadcrumbs',
        name: 'Breadcrumbs',
        view: () => (
          <VStack gap={1}>
            <Breadcrumbs items={crumbTrail} onNavigate={(key) => crumb.set(key)} />
            <Text style={[styles.muted]}>{`navigated: ${crumb.get()}`}</Text>
          </VStack>
        ),
      },
      {
        key: 'pagination',
        name: 'Pagination',
        controls: {
          pages: { type: 'number', default: 20, min: 1, max: 30 },
          siblings: { type: 'number', label: 'Siblings', default: 1, min: 0, max: 3 },
        },
        view: (args) => {
          const pages = Math.max(1, Number(args.pages));
          const siblings = Math.max(0, Number(args.siblings));
          const page = Math.min(pageAt.get(), pages);
          return (
            <VStack gap={1}>
              <Pagination
                page={page}
                pages={pages}
                siblings={siblings}
                onChange={(next) => pageAt.set(next)}
              />
              <Text style={[styles.muted]}>{`page ${page} of ${pages}`}</Text>
            </VStack>
          );
        },
      },
      {
        key: 'steps',
        name: 'Steps',
        controls: {
          current: { type: 'select', options: ['plan', 'build', 'test', 'ship'], default: 'build' },
        },
        view: (args) => (
          <Steps
            current={String(args.current)}
            steps={[
              { key: 'plan', label: 'Plan' },
              { key: 'build', label: 'Build' },
              { key: 'test', label: 'Test' },
              { key: 'ship', label: 'Ship' },
            ]}
          />
        ),
      },
    ],
  };
}

function dataGroup(): StoryGroup {
  const tree = createTreeState(['src']);
  const picked = createSignal<string | null>('a');
  const row = createSignal(0);
  const virtualRows = 10;
  const virtual = new VirtualScroll();
  virtual.setCount(500);
  const virtualVersion = createSignal(0);
  const virtualBump = (): void => virtualVersion.set(virtualVersion.get() + 1);
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
      {
        key: 'timeline',
        name: 'Timeline',
        view: () => (
          <Timeline
            entries={[
              { key: 'boot', title: 'Runtime booted', detail: '12ms' },
              { key: 'build', title: 'Build finished', detail: '420ms', variant: 'success' },
              { key: 'cache', title: 'Cache miss', detail: 'cold start', variant: 'warning' },
              { key: 'deploy', title: 'Deploy failed', detail: 'rolled back', variant: 'danger' },
              { key: 'retry', title: 'Retry scheduled', variant: 'info' },
            ]}
          />
        ),
      },
      {
        key: 'virtual-list',
        name: 'VirtualList',
        view: () => {
          virtualVersion.get();
          const slice = virtual.window(virtualRows);
          return (
            <VStack gap={1}>
              <VirtualList
                height={virtualRows}
                window={slice}
                offset={virtual.offset}
                onMouse={(event) => {
                  if (virtual.handleWheel(event, virtualRows)) {
                    virtualBump();
                    return true;
                  }
                  return false;
                }}
                onScroll={(offset) => {
                  virtual.scrollTo(offset, virtualRows);
                  virtualBump();
                }}
              >
                {Array.from({ length: slice.end - slice.start }, (_, i) => {
                  const index = slice.start + i;
                  return (
                    <Text key={String(index)}>{`item ${String(index).padStart(3, '0')}`}</Text>
                  );
                })}
              </VirtualList>
              <HStack gap={1}>
                <Button
                  label="Jump to end"
                  onClick={() => {
                    virtual.scrollToEnd(virtualRows);
                    virtualBump();
                  }}
                />
                <Text
                  style={[styles.muted]}
                >{`offset ${virtual.offset}/${virtual.totalRows}`}</Text>
              </HStack>
            </VStack>
          );
        },
      },
    ],
  };
}

function typographyGroup(): StoryGroup {
  const activated = createSignal(0);
  const sampleCode = [
    'function greet(name: string): string {',
    '  // say hello',
    '  return `Hello, ${name}!`;',
    '}',
  ].join('\n');
  return {
    title: 'Typography',
    stories: [
      {
        key: 'heading',
        name: 'Heading',
        controls: {
          level: { type: 'number', default: 1, min: 1, max: 6, step: 1 },
        },
        view: (args) => (
          <VStack gap={1}>
            <Heading level={Math.min(6, Math.max(1, Number(args.level))) as 1 | 2 | 3 | 4 | 5 | 6}>
              Release notes
            </Heading>
            <Text style={[styles.muted]}>Body copy beneath the heading.</Text>
          </VStack>
        ),
      },
      {
        key: 'emphasis',
        name: 'Bold & Italic',
        view: () => (
          <VStack gap={1}>
            {/* Text flattens descendant nodes to plain text in the terminal —
                mixed inline styling composes as row siblings instead. */}
            <HStack gap={0}>
              <Text>Plain, </Text>
              <Bold>bold</Bold>
              <Text>, and </Text>
              <Italic>italic</Italic>
              <Text> text mixed inline.</Text>
            </HStack>
            <HStack gap={1}>
              <Bold>Warning:</Bold>
              <Italic>this action cannot be undone.</Italic>
            </HStack>
          </VStack>
        ),
      },
      {
        key: 'link',
        name: 'Link',
        controls: {
          mode: { type: 'select', options: ['href', 'handler'], default: 'href' },
        },
        view: (args) => (
          <VStack gap={1}>
            {args.mode === 'handler' ? (
              <Link id="story-link" onActivate={() => activated.set(activated.get() + 1)}>
                Run the build
              </Link>
            ) : (
              <Link href="https://fino.dev/docs">Read the docs</Link>
            )}
            <Text style={[styles.muted]}>
              {args.mode === 'handler'
                ? `activated ${activated.get()} times`
                : 'href renders a real <a> on the web'}
            </Text>
          </VStack>
        ),
      },
      {
        key: 'blockquote',
        name: 'Blockquote',
        view: () => (
          <Blockquote>
            <Text>Measure twice, cut once.</Text>
            <Text style={[styles.dim]}>— attributed to every carpenter, ever</Text>
          </Blockquote>
        ),
      },
      {
        key: 'list',
        name: 'List',
        controls: {
          ordered: { type: 'boolean', default: false },
        },
        view: (args) => (
          <List
            ordered={args.ordered === true}
            items={[
              'Clone the repo',
              'Install dependencies',
              <HStack gap={0}>
                <Text>Run </Text>
                <InlineCode>cargo build</InlineCode>
              </HStack>,
            ]}
          />
        ),
      },
      {
        key: 'code',
        name: 'Code',
        controls: {
          language: { type: 'select', options: ['ts', 'js', 'plain'], default: 'ts' },
          showLineNumbers: { type: 'boolean', default: true },
          filename: { type: 'text', default: 'greet.ts' },
          copyable: { type: 'boolean', default: true },
        },
        view: (args) => (
          <VStack gap={1}>
            <Code
              code={sampleCode}
              language={args.language === 'plain' ? undefined : String(args.language)}
              showLineNumbers={args.showLineNumbers === true}
              filename={String(args.filename).length > 0 ? String(args.filename) : undefined}
              copyable={args.copyable === true}
              onCopy={(code) => copyToClipboard(code)}
            />
            <HStack gap={0}>
              <Text>Inline: </Text>
              <InlineCode>npm install fino</InlineCode>
            </HStack>
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

const STATUS_DOT_VALUES: StatusDotStatus[] = ['ok', 'busy', 'error', 'idle', 'warning'];

function displayGroup(): StoryGroup {
  const cardSynced = createSignal(0);
  const emptyCleared = createSignal(0);
  return {
    title: 'Display',
    stories: [
      {
        key: 'card',
        name: 'Card',
        controls: {
          withImage: { type: 'boolean', label: 'Image', default: true },
        },
        view: (args) => (
          <Card
            title="Notebook sync"
            subtitle="Last synced 2 minutes ago"
            image={
              args.withImage === true
                ? { src: 'https://fino.dev/img/notebook.png', alt: 'Notebook cover art' }
                : undefined
            }
            actions={[
              <Button key="dismiss" label="Dismiss" onClick={() => {}} />,
              <Button
                key="sync"
                label="Sync now"
                onClick={() => cardSynced.set(cardSynced.get() + 1)}
              />,
            ]}
          >
            <VStack gap={0}>
              <Text style={[styles.muted]}>Changes sync automatically every five minutes.</Text>
              <Text style={[styles.dim]}>{`synced ${cardSynced.get()} times`}</Text>
            </VStack>
          </Card>
        ),
      },
      {
        key: 'stat',
        name: 'Stat',
        controls: {
          trend: { type: 'select', options: ['up', 'down', 'flat', 'none'], default: 'up' },
        },
        view: (args) => (
          <HStack gap={3}>
            <Stat
              label="Active sessions"
              value="1,204"
              hint="last 24h"
              trend={args.trend === 'none' ? undefined : (args.trend as Trend)}
            />
            <Stat label="Error rate" value="0.4%" trend="down" />
            <Stat label="Queue depth" value="12" />
          </HStack>
        ),
      },
      {
        key: 'status-dot',
        name: 'StatusDot',
        controls: {
          status: { type: 'select', options: [...STATUS_DOT_VALUES], default: 'ok' },
        },
        view: (args) => (
          <VStack gap={1}>
            <StatusDot status={args.status as StatusDotStatus} label={String(args.status)} />
            <HStack gap={2}>
              {STATUS_DOT_VALUES.map((status) => (
                <StatusDot key={status} status={status} label={status} />
              ))}
            </HStack>
          </VStack>
        ),
      },
      {
        key: 'empty-state',
        name: 'EmptyState',
        view: () => (
          <VStack gap={1}>
            <Box border width={40} height={10}>
              <EmptyState
                grow={1}
                icon="doc"
                title="No results"
                description="Try a different search term."
                action={
                  <Button
                    label="Clear filters"
                    onClick={() => emptyCleared.set(emptyCleared.get() + 1)}
                  />
                }
              />
            </Box>
            <Text style={[styles.muted]}>{`cleared ${emptyCleared.get()} times`}</Text>
          </VStack>
        ),
      },
      {
        key: 'hover-card',
        name: 'HoverCard',
        controls: {
          open: { type: 'boolean', default: true },
        },
        view: (args) => (
          <VStack gap={1}>
            <Text id="hover-card-anchor">Release 1.4.0 (anchor)</Text>
            <HoverCard open={args.open === true} anchorId="hover-card-anchor" title="Release 1.4.0">
              <Text>Adds the Display component group: Card, Stat, StatusDot, and more.</Text>
              <Text style={[styles.dim]}>Shipped 2 days ago</Text>
            </HoverCard>
          </VStack>
        ),
      },
      {
        key: 'floating-action-bar',
        name: 'FloatingActionBar',
        controls: {
          placement: {
            type: 'select',
            options: ['bottom-center', 'bottom-end'],
            default: 'bottom-center',
          },
        },
        view: (args) => (
          <Box
            id="fab-container"
            border
            direction="column"
            gap={1}
            width={40}
            height={8}
            padding={1}
          >
            <Text style={[styles.muted]}>Chat transcript scrolls here…</Text>
            <FloatingActionBar
              anchorId="fab-container"
              placement={args.placement as 'bottom-center' | 'bottom-end'}
            >
              <Button label="Jump to latest" onClick={() => {}} />
            </FloatingActionBar>
          </Box>
        ),
      },
    ],
  };
}

function disclosureGroup(): StoryGroup {
  const details = createDisclosure(true);
  const tab = createSignal('one');
  const expanded = createSignal(false);
  const accordionSingle = createAccordion(true);
  const accordionMulti = createAccordion();
  return {
    title: 'Disclosure',
    stories: [
      {
        key: 'expander',
        name: 'Expander',
        view: () => (
          <VStack gap={1}>
            <HStack gap={1}>
              <Expander open={expanded.get()} onToggle={(next) => expanded.set(next)} />
              <Text>marker before the label</Text>
            </HStack>
            <HStack gap={1}>
              <Text>marker after the label</Text>
              <Expander open={expanded.get()} onToggle={(next) => expanded.set(next)} />
            </HStack>
            <Text style={[styles.muted]}>{expanded.get() ? 'open' : 'closed'}</Text>
          </VStack>
        ),
      },
      {
        key: 'accordion',
        name: 'Accordion',
        controls: {
          single: { type: 'boolean', default: true },
        },
        view: (args) => {
          const state = args.single === true ? accordionSingle : accordionMulti;
          return (
            <Accordion
              id="gallery-accordion"
              sections={[
                { key: 'general', title: 'General', content: <Text>Session defaults.</Text> },
                { key: 'network', title: 'Network', content: <Text>Proxy and TLS.</Text> },
                {
                  key: 'advanced',
                  title: 'Advanced',
                  content: <Text style={[styles.muted]}>Debug flags.</Text>,
                },
              ]}
              openKeys={state.openKeys.get()}
              onToggle={state.toggle}
            />
          );
        },
      },
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
  const popover = createDisclosure(false);
  return {
    title: 'Menus & overlays',
    stories: [
      {
        key: 'tooltip',
        name: 'Tooltip',
        controls: {
          open: { type: 'boolean', default: true },
        },
        view: (args) => (
          <VStack gap={1}>
            <Text id="tooltip-anchor">Save (anchor)</Text>
            <Tooltip
              text="Writes the buffer to disk"
              open={args.open === true}
              anchorId="tooltip-anchor"
            />
          </VStack>
        ),
      },
      {
        key: 'popover',
        name: 'Popover',
        view: () => (
          <VStack gap={1}>
            <Button
              id="popover-trigger"
              label={popover.open.get() ? 'Close popover' : 'Open popover'}
              onClick={() => popover.set(!popover.open.get())}
            />
            <Popover
              open={popover.open.get()}
              anchorId="popover-trigger"
              onDismiss={() => popover.set(false)}
            >
              <Text>Anchored beneath the trigger.</Text>
              <Text style={[styles.dim]}>esc dismisses</Text>
            </Popover>
          </VStack>
        ),
      },
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

const SWATCHES = [
  '#bf616a',
  '#a3be8c',
  '#ebcb8b',
  '#81a1c1',
  '#b48ead',
  '#88c0d0',
  '#d8dee9',
  '#3b4252',
];

// Every date/time value here is a fixed string — no `Date.now()`, no ambient
// clock — so the terminal and HTML galleries render identically on every
// run, and the interaction tests in tests/ui/pickers.test.tsx can assert
// exact frames.
function timeGroup(): StoryGroup {
  const calMonth = createSignal('2024-06');
  const calSelected = createSignal<string | undefined>('2024-06-15');
  const datePicker = createDisclosure(false);
  const dateValue = createSignal<string | undefined>('2024-06-15');
  const dateMonth = createSignal('2024-06');
  const timePicker = createDisclosure(false);
  const timeValue = createSignal<string | undefined>('14:30');
  const colorValue = createSignal('#88c0d0');
  const colorPicker = createDisclosure(false);

  return {
    title: 'Time & pickers',
    stories: [
      {
        key: 'calendar',
        name: 'Calendar',
        controls: {
          weekStartsOn: {
            type: 'select',
            label: 'Week starts on',
            options: ['0', '1'],
            default: '0',
          },
        },
        view: (args) => (
          <VStack gap={1}>
            <Calendar
              id="gallery-calendar"
              month={calMonth.get()}
              selected={calSelected.get()}
              today="2024-06-10"
              weekStartsOn={(args.weekStartsOn === '1' ? 1 : 0) as 0 | 1}
              onSelect={(date) => calSelected.set(date)}
              onMonthChange={(month) => calMonth.set(month)}
            />
            <Text style={[styles.muted]}>{`selected: ${calSelected.get() ?? '—'}`}</Text>
          </VStack>
        ),
      },
      {
        key: 'digital-clock',
        name: 'DigitalClock',
        controls: {
          time: { type: 'text', default: '09:41:00' },
          seconds: { type: 'boolean', default: true },
          label: { type: 'text', default: 'Local time' },
        },
        view: (args) => (
          <DigitalClock
            time={String(args.time)}
            seconds={args.seconds === true}
            label={String(args.label).length > 0 ? String(args.label) : undefined}
          />
        ),
      },
      {
        key: 'date-picker',
        name: 'DatePicker',
        controls: {
          weekStartsOn: {
            type: 'select',
            label: 'Week starts on',
            options: ['0', '1'],
            default: '0',
          },
        },
        view: (args) => (
          <VStack gap={1} width={30}>
            <DatePicker
              id="gallery-date-picker"
              value={dateValue.get()}
              open={datePicker.open.get()}
              onOpenChange={(next) => datePicker.set(next)}
              onChange={(date) => dateValue.set(date)}
              month={dateMonth.get()}
              onMonthChange={(month) => dateMonth.set(month)}
              today="2024-06-10"
              weekStartsOn={(args.weekStartsOn === '1' ? 1 : 0) as 0 | 1}
            />
            <Text style={[styles.muted]}>Click the trigger to open the calendar popover.</Text>
          </VStack>
        ),
      },
      {
        key: 'time-picker',
        name: 'TimePicker',
        controls: {
          step: { type: 'number', label: 'Minute step', default: 5, min: 1, max: 30 },
          seconds: { type: 'boolean', default: false },
        },
        view: (args) => (
          <VStack gap={1} width={30}>
            <TimePicker
              id="gallery-time-picker"
              value={timeValue.get()}
              open={timePicker.open.get()}
              onOpenChange={(next) => timePicker.set(next)}
              onChange={(value) => timeValue.set(value)}
              step={Number(args.step)}
              seconds={args.seconds === true}
            />
            <Text style={[styles.muted]}>Arrow keys step while open; Enter/Esc close.</Text>
          </VStack>
        ),
      },
      {
        key: 'color-picker',
        name: 'ColorPicker',
        controls: {
          popover: { type: 'boolean', label: 'Popover mode', default: false },
        },
        view: (args) => {
          const popover = args.popover === true;
          return (
            <VStack gap={1}>
              <ColorPicker
                id="gallery-color-picker"
                value={colorValue.get()}
                onChange={(value) => colorValue.set(value)}
                swatches={SWATCHES}
                open={popover ? colorPicker.open.get() : undefined}
                onOpenChange={popover ? (next) => colorPicker.set(next) : undefined}
              />
              <Text style={[styles.muted]}>{`value: ${colorValue.get()}`}</Text>
            </VStack>
          );
        },
      },
    ],
  };
}

// Fixed sample data — deterministic, no `Math.random()`, so the gallery (and
// anything that snapshots it, e.g. the HTML target's markup assertions in
// tests) renders identically on every run.
const BAR_CATEGORIES = ['Q1', 'Q2', 'Q3', 'Q4'];
const BAR_SERIES: Series[] = [
  { key: 'north', label: 'North', points: [12, 19, 8, 24] },
  { key: 'south', label: 'South', points: [9, 14, 17, 11] },
  { key: 'east', label: 'East', points: [15, 6, 21, 13] },
];
const LINE_SERIES: Series[] = [
  { key: 'p50', label: 'p50 latency', points: [12, 14, 11, 15, 13, 16, 14, 18, 15, 17] },
  { key: 'p99', label: 'p99 latency', points: [30, 34, 28, 36, 33, 40, 35, 44, 38, 42] },
  { key: 'errors', label: 'error rate', points: [1, 2, 1, 3, 2, 2, 4, 3, 2, 1] },
];

function chartsGroup(): StoryGroup {
  return {
    title: 'Charts',
    stories: [
      {
        key: 'bar-chart',
        name: 'BarChart',
        controls: {
          seriesCount: { type: 'number', label: 'Series', default: 2, min: 1, max: 3, step: 1 },
          height: { type: 'number', default: 8, min: 3, max: 12, step: 1 },
          horizontal: { type: 'boolean', default: false },
          showValues: { type: 'boolean', default: false },
        },
        view: (args) => (
          <BarChart
            series={BAR_SERIES.slice(0, Number(args.seriesCount))}
            labels={BAR_CATEGORIES}
            height={Number(args.height)}
            horizontal={args.horizontal === true}
            showValues={args.showValues === true}
          />
        ),
      },
      {
        key: 'line-chart',
        name: 'LineChart',
        controls: {
          seriesCount: { type: 'number', label: 'Series', default: 2, min: 1, max: 3, step: 1 },
          height: { type: 'number', default: 8, min: 3, max: 12, step: 1 },
          showAxis: { type: 'boolean', label: 'Axis', default: true },
          showLegend: { type: 'boolean', label: 'Legend', default: true },
        },
        view: (args) => (
          <LineChart
            series={LINE_SERIES.slice(0, Number(args.seriesCount))}
            height={Number(args.height)}
            showAxis={args.showAxis === true}
            showLegend={args.showLegend === true}
          />
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
  return [
    layoutGroup(),
    formsGroup(),
    indicatorsGroup(),
    feedbackGroup(),
    navigationGroup(),
    disclosureGroup(),
    overlayGroup(),
    dataGroup(),
    typographyGroup(),
    displayGroup(),
    timeGroup(),
    chartsGroup(),
  ];
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
          </Clickable>
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
