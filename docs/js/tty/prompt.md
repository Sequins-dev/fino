# prompt

fino:tty/prompt — interactive command-line prompts with non-interactive
defaults.

PromptSession wraps the low-level `fino:tty` helpers and centralizes the
policy for CI or redirected input: prompts either return explicit defaults
or throw instead of blocking forever.

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

### constructor

```ts
constructor(options: PromptSessionOptions = {})
```

### text

```ts
async text(options: TextPromptOptions): Promise<string>
```

Ask for a text value, repeating until optional validation passes.

### confirm

```ts
async confirm(options: ConfirmPromptOptions): Promise<boolean>
```

Ask a yes/no question and return the selected boolean value.

### select

```ts
async select(options: SelectPromptOptions): Promise<string>
```

Ask the user to choose one labeled option and return its value.

## createDefaultPrompt

```ts
function createDefaultPrompt(): PromptSession
```

Create a PromptSession using the process standard input and output.
