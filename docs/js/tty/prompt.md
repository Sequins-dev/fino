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
