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

## Semantic icons

`Icon` and `IconButton` resolve names through one semantic registry. Terminal
forms remain compact monochrome glyphs, while HTML can use richer forms. Pass an
`icons` table to either component to override names without branching in the
application tree; unknown names consistently fall back to `file`.

Each family also owns a small preview descriptor beside its implementation.
The preview host can aggregate those descriptors later without coupling the
components to a CLI or browser runtime.
