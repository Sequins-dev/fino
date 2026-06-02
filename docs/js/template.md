# template

fino:template — small Mustache-compatible template rendering.

Supports escaped variables, triple-mustache/unescaped variables, truthy and
inverted sections, list iteration, and dotted-name lookup. Partials are
intentionally not implemented yet.

## RenderOptions

```ts
interface RenderOptions {
```

Options accepted by one-shot template rendering. Reserved for future flags.

## CompileOptions

```ts
interface CompileOptions extends RenderOptions {
```

Options accepted by template compilation. Reserved for future flags.

## escapeHtml

```ts
function escapeHtml(value: unknown): string
```

Escape a value for safe insertion into HTML text or attributes.

## compile

```ts
function compile(template: string, _options: CompileOptions = {}): (data?: unknown) => string
```

Compile a template string into a reusable render function.

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

```ts
import { render } from 'fino:template';

render('{{#items}}{{.}} {{/items}}', { items: ['a', 'b'] });
```
