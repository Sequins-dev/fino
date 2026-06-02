# template

fino:template — small Mustache-compatible template rendering.

Supports escaped variables, triple-mustache/unescaped variables, truthy and
inverted sections, list iteration, and dotted-name lookup. Partials are
intentionally not implemented yet.

```ts
import { compile, render } from 'fino:template';

const renderUser = compile('{{#active}}{{name}}{{/active}}{{^active}}disabled{{/active}}');
const output = renderUser({ active: true, name: '<Ada>' });
const list = render('{{#items}}{{.}} {{/items}}', { items: ['a', 'b'] });
```

## RenderOptions

```ts
interface RenderOptions {
```

Options accepted by one-shot template rendering.

The current renderer has no runtime flags, so this interface is intentionally
empty and exists to keep `render()` forward-compatible with future escaping
or partial-loading options.

```ts
import { render, type RenderOptions } from 'fino:template';

const options: RenderOptions = {};
render('Hello {{name}}', { name: 'Ada' }, options);
```

## CompileOptions

```ts
interface CompileOptions extends RenderOptions {
```

Options accepted by template compilation.

`CompileOptions` currently inherits the empty `RenderOptions` shape. Pass the
same options to `compile()` that you would pass to `render()`.

```ts
import { compile, type CompileOptions } from 'fino:template';

const options: CompileOptions = {};
const renderUser = compile('{{name}}', options);
renderUser({ name: 'Ada' });
```

## escapeHtml

```ts
function escapeHtml(value: unknown): string
```

Escape a value for safe insertion into HTML text or attributes.

`null` and `undefined` become the empty string. Other values are stringified
and the five HTML-sensitive characters (`&`, `<`, `>`, `"`, and `'`) are
replaced with entities. This is the same escaping used for normal
`{{name}}` template variables.

```ts
import { escapeHtml } from 'fino:template';

escapeHtml('<script>alert("x")</script>');
// '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
```

## compile

```ts
function compile(template: string, _options: CompileOptions = {}): (data?: unknown) => string
```

Compile a template string into a reusable render function.

The returned function accepts any data value. Objects are searched by own
properties, maps by key, arrays and other iterables drive sections, and
dotted names traverse nested objects. Syntax errors such as unclosed
sections throw during compilation.

```ts
import { compile } from 'fino:template';

const renderUser = compile('Hello, {{name}}');
renderUser({ name: '<Ada>' }); // 'Hello, &lt;Ada&gt;'
```

## render

```ts
function render(template: string, data: unknown = {}, options: RenderOptions = {}): string
```

Render a template once with the provided data.

This is equivalent to `compile(template, options)(data)`. Use `compile()`
directly when the same template is rendered repeatedly.

```ts
import { render } from 'fino:template';

render('{{#items}}{{.}} {{/items}}', { items: ['a', 'b'] });
```
