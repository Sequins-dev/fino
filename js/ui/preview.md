---
weight: 15
---

# Component previews

`fino:ui/preview` renders one component catalog in two places: a retained
terminal application and a live browser page. Preview views return ordinary
`fino:ui` trees, so they exercise the same target lowerings as production code.
There is no preview-specific component renderer.

Run the built-in catalog in the terminal:

```sh
fino preview
```

Or serve it locally in a browser:

```sh
fino preview --html --port 3080
```

The browser runner uses the existing `fino:ui/web` action protocol. Controls
and component handlers post server actions, and updated trees return as SSE
render events for in-place DOM reconciliation. The same forms remain usable as
ordinary requests when client enhancement is unavailable.

## Preview application components

A preview module default-exports an array of groups. Keys must be unique across
the complete catalog because terminal selection, browser links, and action
state all address previews by the same key.

```ts no_run
import { h } from 'fino:ui';
import { Panel, Text } from 'fino:ui/components';
import type { PreviewGroup } from 'fino:ui/preview';

export default [
  {
    title: 'Application',
    previews: [
      {
        key: 'welcome-card',
        name: 'Welcome card',
        controls: {
          title: { type: 'text', default: 'Hello' },
          bordered: { type: 'boolean', default: true },
        },
        view: (args) =>
          h(
            Panel,
            { title: String(args.title), border: args.bordered === true },
            h(Text, null, 'Preview content'),
          ),
      },
    ],
  },
] satisfies PreviewGroup[];
```

Pass the module to either runner:

```sh
fino preview ./previews.ts
fino preview ./previews.ts --html
```

Preview descriptors own demonstrations, not component contracts. Keep behavior
tests beside the component family; use the preview suite for catalog-wide key
validation, dual-target renderability, runner navigation, and live action
transport.

## Programmatic runners

Use `runPreviewTui()` for a fullscreen terminal catalog. `runPreviewHtml()`
returns the same `ServeServer` contract as the HTTP server APIs, including
`ready`, `close()`, and async disposal. `createPreviewApp()` returns the app
without opening a listener, which is useful for composition and deterministic
request tests. `previewPage()` produces a static progressively enhanced page.

```ts no_run
import { catalogPreviews, runPreviewHtml } from 'fino:ui/preview';

await using server = runPreviewHtml({
  hostname: '127.0.0.1',
  port: 0,
  groups: catalogPreviews(),
});
await server.ready;
console.log(`preview: http://127.0.0.1:${server.port}`);
```

The built-in catalog is assembled from co-located `*.preview.ts` modules. A
family controls its own examples and state; the catalog only validates and
orders them. This keeps preview additions local and avoids a second central
registry of component behavior.
