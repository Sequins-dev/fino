---
weight: 10
---

# Host-neutral UI components

`fino:ui/components` starts with a small structural vocabulary shared by every
render target. `Box`, `Text`, `Spacer`, `Input`, `Layer`, `Clickable`, `Scroll`,
and `Rule` describe layout and interaction without branching on HTML or terminal
execution.

```ts no_run
/** @jsxImportSource fino:ui */
import { Box, Rule, Text, styles } from 'fino:ui/components';

export const view = (
  <Box border padding={1} gap={1}>
    <Text style={[styles.bold, styles.accent]}>Session</Text>
    <Rule />
    <Text>ready</Text>
  </Box>
);
```

The semantic `styles` table keeps intent independent of output. The terminal
turns those values into SGR attributes; the HTML target maps the same values to
CSS custom properties.

## Render targets

Terminal applications can continue importing primitives from `fino:tty/tui`;
those re-exports are the same component values. The retained terminal target
lowers a tree to a closed primitive floor before layout, so unsupported semantic
nodes fail with a named render-target error.

For HTML, transform a tree with `toHtml()` and serialize it with
`renderToHtml()`:

```ts no_run
import { Box, Text } from 'fino:ui/components';
import { htmlPage, toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';

const tree = Box({ children: Text({ children: 'hello' }) });
const page = htmlPage(renderToHtml(toHtml(tree)), { title: 'Example' });
console.log(page);
```

Component families keep their CSS beside their implementation and register the
fragment once. `htmlPage()` aggregates fragments registered by family modules
loaded in the current Realm with the base palette, avoiding a second monolithic
stylesheet.

## Layout families

`VStack`, `HStack`, and `Stack` are target-neutral compositions over `Box`.
`Panel` provides a titled region, while `Field` and `Fieldset` preserve native
labeling semantics in HTML and use titled, retained layouts in the terminal.

```ts no_run
/** @jsxImportSource fino:ui */
import { Field, Fieldset, Input, Panel, VStack } from 'fino:ui/components';

const settings = (
  <Panel title="Account">
    <VStack gap={1}>
      <Fieldset legend="Identity">
        <Field id="email" label="Email" hint="Use your work address" required>
          <Input value="hello@example.com" />
        </Field>
      </Fieldset>
    </VStack>
  </Panel>
);
```

## Typography and code

Headings, emphasis, links, quotes, lists, and inline code use semantic HTML and
equivalent terminal styling. `Code` delegates tokenization to the reusable
`highlightLines()` service from `fino:format/typescript`, so HTML classes and
terminal colors are two presentations of the same token runs.

```ts no_run
/** @jsxImportSource fino:ui */
import { Code, Heading, Link, VStack } from 'fino:ui/components';

const guide = (
  <VStack gap={1}>
    <Heading level={2}>Build</Heading>
    <Code code="const ready: boolean = true;" language="ts" showLineNumbers />
    <Link href="https://fino.dev">Read the guide</Link>
  </VStack>
);
```

Links accept HTTP, HTTPS, mail, telephone, and relative targets. Unknown or
active schemes such as `javascript:` render without a live `href`. Handler links
and icon buttons reuse the HTML target's shared action protocol.

## Forms and text editing

`Button`, `Checkbox`, `Radio`, `RadioGroup`, and `Switch` expose controlled
actions and choices. `TextInput`, `TextArea`, `NumberInput`, and `Slider` expose
controlled values. Their application-facing definitions remain target-neutral:
HTML lowers them to native controls through one value/action adapter, while the
terminal target composes the same callbacks with retained focus and mouse
routing.

```ts no_run
/** @jsxImportSource fino:ui */
import {
  Button,
  Field,
  Slider,
  TextArea,
  TextInput,
  VStack,
  createTextArea,
  createTextField,
} from 'fino:ui/components';

const name = createTextField('Ada');
const notes = createTextArea('Ready');

const form = (
  <VStack gap={1}>
    <Field label="Name">
      <TextInput
        value={name.value.get()}
        caret={name.caret.get()}
        selection={name.selection.get()}
        onChange={name.set}
      />
    </Field>
    <TextArea
      value={notes.value.get()}
      caret={notes.caret.get()}
      selection={notes.selection.get()}
      onChange={notes.set}
    />
    <Slider value={50} min={0} max={100} onChange={(value) => console.log(value)} />
    <Button label="Save" onClick={() => console.log('save')} />
  </VStack>
);
```

`createTextField()` and `createTextArea()` share one value/caret/selection
controller contract. The terminal reducers replace selections, move and delete
by character or word, and clamp caret positions. Multi-line state additionally
handles line-relative Home/End, vertical movement, and newline insertion. Plain
Enter submits a `TextInput`; a `TextArea` reserves plain Enter for a newline and
uses Control+Enter as its explicit terminal submit gesture.

Numeric controls reject non-finite updates and clamp to their bounds. Terminal
sliders use the same fraction-to-step mapping for horizontal clicks and vertical
clicks or drags, so orientation changes presentation rather than value policy.

## Disclosure and menus

`Details`, `Tabs`, and `Accordion` keep their open or active state controlled by
the application. `createDisclosure()` and `createAccordion()` provide optional
signal-backed state without hiding ownership inside the component tree.
`MenuList`, `Select`, and `ComboBox` share enabled-item navigation and selection
rules. Headers, separators, and disabled rows are skipped consistently, and
`ListSelection` keeps a bounded row window aligned with the active item.

```ts no_run
/** @jsxImportSource fino:ui */
import {
  ComboBox,
  Details,
  Select,
  Tabs,
  createDisclosure,
} from 'fino:ui/components';

const disclosure = createDisclosure(true);

const controls = (
  <Details
    title="Filters"
    open={disclosure.open.get()}
    onToggle={disclosure.set}
  >
    <Select
      id="status"
      value="open"
      open={false}
      options={[
        { key: 'open', label: 'Open' },
        { key: 'closed', label: 'Closed' },
      ]}
      onChange={(key) => console.log(key)}
    />
  </Details>
);
```

In HTML, grouped tabs, breadcrumbs, pagination, and native selects each register
one value action for the entire control instead of one action per row. In the
terminal, Select and ComboBox compose the same `Popover` used by other anchored
surfaces. Escape dismissal and enabled-item movement come from shared helpers,
so controls do not drift into subtly different keyboard behavior.

## Navigation

`Breadcrumbs`, `Pagination`, and `Steps` present location and progress without
owning routing state. `paginationRange()` is the shared boundary and ellipsis
algorithm used by both render targets.

```ts no_run
/** @jsxImportSource fino:ui */
import { Breadcrumbs, Pagination, Steps, VStack } from 'fino:ui/components';

const navigation = (
  <VStack gap={1}>
    <Breadcrumbs
      items={[
        { key: 'home', label: 'Home' },
        { key: 'project', label: 'Project' },
      ]}
      onNavigate={(key) => console.log(key)}
    />
    <Pagination page={7} pages={20} onChange={(page) => console.log(page)} />
    <Steps
      current="review"
      steps={[
        { key: 'draft', label: 'Draft' },
        { key: 'review', label: 'Review' },
        { key: 'done', label: 'Done' },
      ]}
    />
  </VStack>
);
```

## Anchored and overlay surfaces

`Popover`, `Tooltip`, `HoverCard`, and `FloatingActionBar` all anchor to a stable
component `id`. `Select` and `ComboBox` build their terminal option surfaces on
that same Popover contract. `Modal` and `ContextMenu` add dismissal boundaries;
their terminal lowerings share one Escape handler, and context menus add an
outside-click catch layer. `Toast` and `ToastStack` provide transient status
surfaces without introducing hidden timers.

```ts no_run
/** @jsxImportSource fino:ui */
import { Button, Modal, Popover, ToastStack } from 'fino:ui/components';

const overlays = (
  <>
    <Button id="actions" label="Actions" onClick={() => {}} />
    <Popover open anchorId="actions" onDismiss={() => {}}>
      Anchored actions
    </Popover>
    <Modal title="Confirm" onDismiss={() => {}}>Review the operation.</Modal>
    <ToastStack toasts={[{ id: 'saved', message: 'Saved', variant: 'success' }]} />
  </>
);
```

## Feedback and display

`Badge`, `Spinner`, `ProgressBar`, `KeyHint`, `Tag`, and `TagGroup` provide
compact status surfaces. `normalizeProgress()` is the one clamping and
percentage contract used by both HTML and terminal progress bars. Unpinned
terminal spinners share one clock whose lifetime is explicitly held by a live
TUI app, so multiple spinners do not install multiple timers and stopped apps
do not keep the event loop awake.

`Card`, `Stat`, `StatusDot`, and `EmptyState` cover common presentation states.
Status and trend components always include a glyph or accessible label, so
meaning does not rely on color alone. Card image URLs use the same safe URL
allowlist as links.

```ts no_run
/** @jsxImportSource fino:ui */
import { Badge, Card, ProgressBar, Stat, StatusDot, VStack } from 'fino:ui/components';

const summary = (
  <Card title="Deployment" subtitle="Production">
    <VStack gap={1}>
      <StatusDot status="ok" label="Healthy" />
      <ProgressBar value={0.72} showPercent />
      <Stat label="Requests" value="12.4k" trend="up" />
      <Badge label="Ready" variant="success" />
    </VStack>
  </Card>
);
```

## Tables, trees, and timelines

`Table`, `FileTree`, and `Timeline` keep data and interaction state controlled
by the application. Table and tree HTML lowerings each register one grouped
action for the whole control instead of one action per row. `visibleTreeRows()`
is shared by HTML and terminal targets, so expansion determines the same bounded
set of rendered rows everywhere. `createTreeState()` optionally owns expansion
and selection signals outside component bodies.

```ts no_run
/** @jsxImportSource fino:ui */
import { FileTree, Table, createTreeState } from 'fino:ui/components';

const tree = createTreeState(['src'], 'main');

const files = (
  <FileTree
    nodes={[
      {
        key: 'src',
        label: 'src',
        children: [{ key: 'main', label: 'main.ts' }],
      },
    ]}
    expanded={tree.expanded.get()}
    selectedKey={tree.selectedKey.get()}
    onToggle={tree.toggle}
    onSelect={tree.select}
  />
);
```

## Virtual lists

`VirtualScroll` is a target-neutral sparse measurement model. Its memory use is
proportional to rows with corrected heights rather than total item count, and
`window()` returns only the indices and spacers needed for one viewport. Build
children only for `start..end` and pass them to `VirtualList`. Browser scrolling
and terminal wheel input remain explicit callbacks into the same model.

```ts no_run
/** @jsxImportSource fino:ui */
import { Text, VirtualList, VirtualScroll } from 'fino:ui/components';

const model = new VirtualScroll({ estimate: 1 });
model.setCount(1_000_000);
const height = 20;
const window = model.window(height);

const list = (
  <VirtualList
    height={height}
    window={window}
    offset={model.offset}
    onMouse={(event) => model.handleWheel(event, height)}
    onScroll={(offset) => model.scrollTo(offset, height)}
  >
    {Array.from({ length: window.end - window.start }, (_, index) => (
      <Text key={String(window.start + index)}>Row {window.start + index}</Text>
    ))}
  </VirtualList>
);
```

## Date, time, and color pickers

`Calendar`, `DigitalClock`, `DatePicker`, `TimePicker`, and `ColorPicker` keep
their values and open state controlled by the application. Browsers receive
native date, time, and color inputs. Terminal date, time, and optional color
overlays compose the same `Popover` behavior as menus and dialogs.

Date and time helpers are clock-free: callers supply the displayed month,
current date, and clock value, which keeps Realm executions repeatable.
`monthGrid()` and `timeColumnWindow()` provide the shared target-independent
math. Terminal colors pass through one truecolor-or-ANSI-256 adapter that later
visualizations can reuse.

```ts no_run
/** @jsxImportSource fino:ui */
import { Calendar, ColorPicker, DigitalClock } from 'fino:ui/components';

const controls = (
  <>
    <Calendar
      month="2024-02"
      selected="2024-02-29"
      onSelect={(date) => console.log(date)}
    />
    <DigitalClock time="23:59:58" seconds label="UTC" />
    <ColorPicker
      value="#3366ff"
      swatches={['#3366ff', '#ff3366']}
      onChange={(color) => console.log(color)}
    />
  </>
);
```

## Semantic icons

`Icon` and `IconButton` resolve names through one semantic registry. Terminal
forms remain compact monochrome glyphs, while HTML can use richer forms. Pass an
`icons` table to either component to override names without branching in the
application tree; unknown names consistently fall back to `file`.

Each family also owns a small preview descriptor beside its implementation.
The preview host can aggregate those descriptors later without coupling the
components to a CLI or browser runtime.
