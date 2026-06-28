---
weight: 35
---
# Evals and OpenTelemetry

Use evals when AI behavior should be protected like tests: prompt regressions,
tool routing, extraction quality, retrieval changes, provider migrations, and
guardrail behavior. Keep deterministic cases in CI, pin or stub models where
possible, and use OpenTelemetry when you need traceable reports across runs.

## Concept Map

- `evaluate()` registers eval cases with the Fino test runner.
- Cases contain inputs, expected values, and any metadata useful to scorers.
- Scorers return numeric scores plus pass/explanation metadata.
- Built-in scorers include `exactMatch`, `contains`, `schemaScorer`,
  `llmJudge`, and `semanticSimilarity`.
- `EvalReporter` receives per-case and summary reports.
- `OpenTelemetryReporter` emits evaluation telemetry without changing test
  semantics.

## Deterministic Eval

Start with deterministic cases and simple scorers. These are the fastest and
most useful checks for CI because failures point to a clear behavior change.

```ts
import { contains, evaluate, exactMatch, schemaScorer } from 'fino:ai/eval';
import { v } from 'fino:validate';

const outputSchema = v.object({
  priority: v.enum(['low', 'normal', 'high']),
  summary: v.string(),
});

evaluate({
  name: 'ticket-classifier',
  cases: [
    {
      name: 'locked out before renewal',
      input: 'I cannot log in and my renewal call starts in ten minutes.',
      expected: { priority: 'high' },
    },
    {
      name: 'thanks message',
      input: 'Thanks, that fixed it.',
      expected: { priority: 'low' },
    },
  ],
  target: async (input: string) => {
    if (input.includes('renewal')) {
      return { priority: 'high', summary: 'Login issue before renewal call.' };
    }
    return { priority: 'low', summary: 'Customer confirmed resolution.' };
  },
  scorers: [
    schemaScorer(outputSchema.schema),
    async (output, c) => exactMatch()(
      (output as { priority: string }).priority,
      { name: c.name, input: c.input, expected: (c.expected as { priority: string }).priority },
    ),
    contains('summary'),
  ],
  threshold: 1,
});
```

Use the same discipline as normal tests: keep case names specific, avoid hidden
network dependencies in CI, and make thresholds reflect a deliberate product
choice.

## Agent Eval

For agent behavior, make the `target` run the same agent configuration the app
uses. In CI, use a fake or pinned model so changes are attributable to code and
prompt edits rather than provider drift.

```ts
import { agent } from 'fino:ai/agent';
import { contains, evaluate } from 'fino:ai/eval';
import { openai } from 'fino:ai/model';

const supportBot = agent({
  model: openai({ model: 'gpt-4o' }),
  instructions: 'Answer refund questions with the exact refund window.',
});

evaluate({
  name: 'refund-policy-agent',
  cases: [
    { name: 'refund window', input: 'How long do I have to request a refund?' },
  ],
  target: async (input: string) => {
    const result = await supportBot.generate(input);
    return result.text;
  },
  scorers: [contains('30 days')],
  threshold: 1,
});
```

## Model Judges

Use `llmJudge()` for qualities that are hard to encode with exact checks, such
as tone or completeness. Treat judge scores as policy, not truth. Pin the judge
model separately from the target model, keep rubrics short, and keep a few
deterministic scorers beside the judge so obvious failures stay obvious.

```ts
import { evaluate, llmJudge } from 'fino:ai/eval';
import { anthropic, openai } from 'fino:ai/model';

const judge = anthropic({ model: 'claude-sonnet-4-6' });
const target = openai({ model: 'gpt-4o' });

evaluate({
  name: 'reply-tone',
  cases: [{ name: 'angry customer', input: 'This is broken again.' }],
  target: async (input: string) => {
    const result = await target.generate({
      system: 'Reply empathetically and briefly.',
      messages: [{ role: 'user', content: input }],
    });
    return result.text;
  },
  scorers: [
    llmJudge(judge, 'Score 1 only if the reply is empathetic, specific, and not defensive.'),
  ],
  threshold: 0.8,
});
```

## OpenTelemetry Reporting

Attach `OpenTelemetryReporter` when eval results should be visible in your
telemetry pipeline. The reporter emits telemetry but does not decide pass/fail;
the test runner still uses scorer values and thresholds.

```ts
import { contains, evaluate, OpenTelemetryReporter } from 'fino:ai/eval';

evaluate({
  name: 'shipping-answer',
  cases: [
    { name: 'shipping delay', input: 'Where is my order?' },
  ],
  target: async () => 'Orders usually ship within two business days.',
  scorers: [contains('two business days')],
  report: new OpenTelemetryReporter({
    endpoint: 'http://127.0.0.1:4318/v1/traces',
  }),
});
```

For local tests, use in-memory OpenTelemetry exporters or omit the reporter.
For CI, emit artifacts or telemetry only after deterministic pass/fail checks
are stable enough to avoid noisy dashboards.

## CI Guidance

- Treat evals as tests and run them with the same review discipline.
- Prefer deterministic target stubs for unit-like prompt and parser checks.
- Pin model ids, prompts, and temperature for integration-style evals.
- Keep model-judge evals separate or clearly labeled if they can drift.
- Record enough metadata to explain failures: case name, input, output,
  expected value, score, and explanation.
- Use OpenTelemetry for observability, not as the only source of pass/fail.
