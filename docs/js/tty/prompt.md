# prompt

fino:tty/prompt — interactive command-line prompts with non-interactive
defaults.

PromptSession wraps the low-level `fino:tty` helpers and centralizes the
policy for CI or redirected input: prompts either return explicit defaults
or throw instead of blocking forever.

```ts
import { PromptSession } from 'fino:tty/prompt';

const prompt = new PromptSession();
const project = await prompt.text({ label: 'Project name', defaultValue: 'app' });
const install = await prompt.confirm({ label: 'Install dependencies', defaultValue: true });
const template = await prompt.select({
  label: 'Template',
  options: [{ label: 'HTTP server', value: 'server' }, 'empty'],
  defaultValue: 'server',
});
```

## TextPromptOptions

```ts
interface TextPromptOptions {
```

Options for a text prompt.

`defaultValue` is returned when the user submits an empty line and is also
used automatically in non-interactive sessions. `validate` may return an
error message to retry the prompt, or `null`/`undefined` to accept the value.

```ts
import { PromptSession } from 'fino:tty/prompt';

const prompt = new PromptSession();
const options = {
  label: 'Project name',
  defaultValue: 'app',
  validate: (value) => value ? null : 'Name is required',
};
await prompt.text(options);
```

### label

```ts
label: string
```

Label shown before the input field.

```ts
const options = { label: 'Project name' };
```

### defaultValue

```ts
defaultValue?: string
```

Value used for empty input and non-interactive mode.

```ts
const options = { label: 'Project name', defaultValue: 'app' };
```

### validate

```ts
validate?: (value: string) => string | null | undefined
```

Optional validator that returns an error message when input is invalid.

```ts
const options = {
  label: 'Port',
  validate: (value: string) => Number(value) > 0 ? null : 'Enter a port',
};
```

## ConfirmPromptOptions

```ts
interface ConfirmPromptOptions {
```

Options for a yes/no prompt.

`defaultValue` controls the hint (`Y/n` or `y/N`) and is returned when the
user submits an empty line. In non-interactive mode it is required.

```ts
import { PromptSession } from 'fino:tty/prompt';

const prompt = new PromptSession();
const options = {
  label: 'Install dependencies',
  defaultValue: true,
};
await prompt.confirm(options);
```

### label

```ts
label: string
```

Question shown before the yes/no hint.

```ts
const options = { label: 'Continue' };
```

### defaultValue

```ts
defaultValue?: boolean
```

Boolean returned for empty input and non-interactive mode.

```ts
const options = { label: 'Overwrite', defaultValue: false };
```

## SelectPromptOptions

```ts
interface SelectPromptOptions {
```

Options for a select prompt.

Options may be strings, where label and value are the same, or objects with
separate display labels and returned values. In non-interactive mode,
`defaultValue` is returned without checking that it appears in `options`.

```ts
import { PromptSession } from 'fino:tty/prompt';

const prompt = new PromptSession();
const options = {
  label: 'Template',
  options: [{ label: 'HTTP server', value: 'server' }, 'empty'],
  defaultValue: 'server',
};
await prompt.select(options);
```

### label

```ts
label: string
```

Heading printed above the numbered choices.

```ts
const options = { label: 'Template', options: ['empty'] };
```

### options

```ts
options: Array<{
  label: string;
  value: string;
} | string>
```

Choices accepted by number, exact label, or exact value.

```ts
const options = {
  label: 'Template',
  options: [{ label: 'HTTP server', value: 'server' }, 'empty'],
};
```

### defaultValue

```ts
defaultValue?: string
```

Value returned for empty input and non-interactive mode.

```ts
const options = {
  label: 'Template',
  options: ['empty'],
  defaultValue: 'empty',
};
```

## PromptSessionOptions

```ts
interface PromptSessionOptions {
```

Constructor options for `PromptSession`.

Tests and CLI tools can inject custom read/write functions to avoid touching
process stdio. When `isInteractive` is false, prompts return defaults or
throw instead of reading from stdin.

```ts
import { PromptSession } from 'fino:tty/prompt';

const options = {
  isInteractive: false,
  readLine: async () => null,
  write: async () => {},
  writeError: async () => {},
};
const prompt = new PromptSession(options);
```

### isInteractive

```ts
isInteractive?: boolean
```

Override automatic TTY detection.

```ts
const options = { isInteractive: false };
```

### readLine

```ts
readLine?: (prompt: string) => Promise<string | null>
```

Function used to read one prompted line.

```ts
const options = { readLine: async (prompt: string) => 'answer' };
```

### write

```ts
write?: (text: string) => Promise<void>
```

Function used for normal prompt output.

```ts
const options = { write: async (text: string) => {} };
```

### writeError

```ts
writeError?: (text: string) => Promise<void>
```

Function used for validation and choice errors.

```ts
const options = { writeError: async (text: string) => {} };
```

## PromptSession

```ts
class PromptSession {
```

Stateful prompt runner for text, confirm, and select questions.

```ts
import { PromptSession } from 'fino:tty/prompt';

const prompt = new PromptSession();
const name = await prompt.text({ label: 'Project name', defaultValue: 'app' });
const install = await prompt.confirm({ label: 'Install dependencies', defaultValue: true });
```

### isInteractive

```ts
isInteractive: boolean
```

Whether this session may ask questions on stdin/stdout.

```ts
import { PromptSession } from 'fino:tty/prompt';

const prompt = new PromptSession({ isInteractive: false });
prompt.isInteractive; // false
```

### constructor

```ts
constructor(options: PromptSessionOptions = {})
```

Create a prompt session.

By default the session is interactive only when both stdin and stdout are
TTYs. Inject `readLine`, `write`, and `writeError` in tests or command
flows that need deterministic prompt behavior.

```ts
import { PromptSession } from 'fino:tty/prompt';

const prompt = new PromptSession({
  isInteractive: true,
  readLine: async () => 'yes',
  write: async () => {},
  writeError: async () => {},
});
```

### text

```ts
async text(options: TextPromptOptions): Promise<string>
```

Ask for a text value, repeating until optional validation passes.

Empty input resolves to `defaultValue` when provided. In non-interactive
mode, this method returns `defaultValue` or throws if no default exists.

```ts
import { PromptSession } from 'fino:tty/prompt';

const prompt = new PromptSession();
const name = await prompt.text({ label: 'Name', defaultValue: 'app' });
```

### confirm

```ts
async confirm(options: ConfirmPromptOptions): Promise<boolean>
```

Ask a yes/no question and return the selected boolean value.

Accepts `y`, `yes`, `n`, and `no` case-insensitively. Empty input uses
`defaultValue` when available.

```ts
import { PromptSession } from 'fino:tty/prompt';

const prompt = new PromptSession();
const proceed = await prompt.confirm({ label: 'Continue', defaultValue: true });
```

### select

```ts
async select(options: SelectPromptOptions): Promise<string>
```

Ask the user to choose one labeled option and return its value.

The user may enter a one-based number, an exact label, or an exact value.
In non-interactive mode, this method returns `defaultValue` or throws if no
default exists.

```ts
import { PromptSession } from 'fino:tty/prompt';

const prompt = new PromptSession();
const template = await prompt.select({
  label: 'Template',
  options: [{ label: 'HTTP server', value: 'server' }, 'empty'],
  defaultValue: 'server',
});
```

## createDefaultPrompt

```ts
function createDefaultPrompt(): PromptSession
```

Create a `PromptSession` using the process standard input and output.

This is a convenience wrapper for `new PromptSession()`. The returned session
follows the same automatic TTY detection and non-interactive default policy.

```ts
import { createDefaultPrompt } from 'fino:tty/prompt';

const prompt = createDefaultPrompt();
const name = await prompt.text({ label: 'Name', defaultValue: 'app' });
```
