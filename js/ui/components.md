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
those exports are aliases of the components above. The retained terminal target
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
