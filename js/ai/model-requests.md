---
weight: 31
---
# Model Requests

Use one-off model requests when the caller has a complete prompt, does not need
tool execution, and can handle parsing or validation itself. This is the
lowest-level AI surface: it is stateless, provider-neutral, and useful for
summarization, classification, extraction, embeddings, and simple generation.

## Concept Map

- `openai()` and `anthropic()` create bundled provider adapters.
- `Model.generate()` returns a complete `GenerateResult`.
- `Model.stream()` emits normalized `StreamEvent` values.
- `assembleResult()` folds stream events into a `GenerateResult`.
- `responseFormat` requests native provider JSON Schema output when supported.
- `agent()` is the next layer up when history, tools, sessions, guardrails, or
  structured-output repair are needed.

## Basic Request

Keep model calls stateless unless the workflow needs history. Send only the
messages required for the current task, include an explicit system instruction
when policy matters, and parse the returned text in application code.

```ts
import { openai } from 'fino:ai/model';

const model = openai({ model: 'gpt-4o' });

const result = await model.generate({
  system: 'Write concise support summaries for internal staff.',
  messages: [
    { role: 'user', content: 'Customer cannot reset MFA after changing phones.' },
  ],
  temperature: 0.2,
  maxTokens: 200,
});

console.log(result.text);
console.log(result.usage);
```

Provider adapters expose `id`, `provider`, and `capabilities` so application
code can make explicit decisions instead of guessing from a model name:

```ts
if (model.capabilities?.structuredOutput?.native) {
  console.log(`${model.provider}:${model.id} supports native structured output`);
}
```

## Streaming

Use streaming when a CLI, chat UI, or log tail should show partial text. The
stream events are provider-neutral; `assembleResult()` is useful when the UI
needs incremental output and the final usage or stop reason.

```ts
import { assembleResult, anthropic } from 'fino:ai/model';
import { writeStdout } from 'fino:tty';

const model = anthropic({ model: 'claude-sonnet-4-6' });
const stream = model.stream({
  messages: [{ role: 'user', content: 'Draft a three-bullet incident update.' }],
});

for await (const event of stream) {
  if (event.type === 'text_delta') {
    await writeStdout(event.text);
  }
}

const result = await assembleResult(model.stream({
  messages: [{ role: 'user', content: 'Summarize the same incident in one line.' }],
}));

console.log(result.stopReason);
```

## Native Structured Output

Native `responseFormat` is a provider request feature. It asks the adapter to
send the provider's JSON Schema response-format option, and the result still
comes back as text. Validate or parse it at the boundary where your code uses
it.

```ts
import { openai } from 'fino:ai/model';
import { compile, v } from 'fino:validate';

const schema = v.object({
  priority: v.enum(['low', 'normal', 'high']).describe('Ticket priority'),
  summary: v.string().describe('One-sentence internal summary'),
});

const model = openai({ model: 'gpt-4o' });
const result = await model.generate({
  messages: [{ role: 'user', content: 'User is locked out before a renewal call.' }],
  responseFormat: {
    type: 'json_schema',
    name: 'ticket_summary',
    schema: schema.schema,
  },
});

const parsed = compile(schema).parse(JSON.parse(result.text));
console.log(parsed.priority, parsed.summary);
```

Use `agent({ output: schema })` instead when the application wants portable
structured-output behavior, a synthetic forced-tool fallback, validation repair,
or `result.object`.

```ts
import { agent } from 'fino:ai/agent';
import { openai } from 'fino:ai/model';
import { v } from 'fino:validate';

const output = v.object({
  priority: v.enum(['low', 'normal', 'high']),
  summary: v.string(),
});

const classifier = agent({
  model: openai({ model: 'gpt-4o' }),
  instructions: 'Classify support tickets.',
  output,
});

const result = await classifier.generate('Cannot access admin billing settings.');
console.log(result.object);
```

## When to Use an Agent Instead

Move up to `fino:ai/agent` when any of these are true:

- The model should call tools or use provider-facing tool schemas.
- The workflow needs durable sessions, history curation, or suspend/resume.
- Structured output should be validated and repaired automatically.
- Guardrails, retries, fallback models, budgets, or stop conditions matter.
- A stream represents an agent loop, not just raw provider text.

Model requests are best when they are small, explicit, and disposable. Keep
state in the caller or use higher-level AI modules when state becomes part of
the behavior.
