---
weight: 36
---
# Skills

Use skills when an agent needs optional expertise that should be discoverable
without loading all instructions, resources, and tools into every prompt. A
skill should be focused, named clearly, and loaded only when relevant to the
current task.

## Concept Map

- `skill()` defines a local or remote SkillsMD-backed skill.
- `skillRegistry()` stores available skills and exposes a `load_skill` tool.
- The agent sees a manifest of skill names and descriptions.
- The model calls `load_skill` when a listed skill is relevant.
- Loaded skill instructions and resources are appended to the prompt surface.
- Local skill tools are registered after load so they can be called later.
- Remote skills are fetched lazily from SkillsMD/GitHub and cached by the
  registry.

## Local Skill

Keep skill descriptions short and searchable. Put durable guidance in
`instructions`, and attach resources when they are useful only after the skill
is selected.

```ts
import { agent } from 'fino:ai/agent';
import { openai } from 'fino:ai/model';
import { skill, skillRegistry } from 'fino:ai/skill';
import { tool } from 'fino:ai/tool';
import { v } from 'fino:validate';

const findPolicy = tool({
  name: 'find_refund_policy',
  description: 'Look up a refund policy section by region.',
  parameters: v.object({
    region: v.enum(['us', 'eu']).describe('Policy region'),
  }),
  execute: async ({ region }: { region: 'us' | 'eu' }) => {
    return region === 'us'
      ? 'US refunds are available for 30 days.'
      : 'EU refunds follow the statutory cooling-off period.';
  },
});

const supportWriting = skill({
  name: 'support-writing',
  description: 'Guidance for concise customer support replies.',
  instructions: [
    'Use a calm, direct tone.',
    'State what is known, what is uncertain, and the next action.',
    'Do not promise refunds without policy support.',
  ].join('\n'),
  resources: [
    {
      name: 'Reply checklist',
      content: '- Acknowledge issue\n- Answer directly\n- Give next step',
    },
  ],
  tools: { findPolicy },
});

const registry = skillRegistry([supportWriting]);

const bot = agent({
  model: openai({ model: 'gpt-4o' }),
  skills: registry,
});
```

The base prompt stays small: it lists that `support-writing` exists and gives
the model a `load_skill` tool. Full instructions, resources, and bundled tools
are loaded only when the model asks for that skill.

## Remote Skills

Remote SkillsMD skills use the same registry path as local skills. The registry
can show placeholder metadata immediately and load the remote markdown lazily
when needed.

```ts
import { skill, skillRegistry } from 'fino:ai/skill';

const registry = skillRegistry([
  skill({
    repo: 'acme/security-review',
    name: 'security-review',
    description: 'Security review guidance for code and design changes.',
    skillsmd: {
      cacheTtlMs: 10 * 60 * 1000,
    },
  }),
]);
```

Only register remote skills from sources you trust. Skills add instructions to
the prompt surface; they are not a sandbox or permission boundary.

## Loader Behavior

`skillRegistry().manifest()` returns names and descriptions for discovery.
`registry.asLoaderTool()` is the tool agents use to load full instructions.
When an agent is configured with `skills: registry`, the runtime adds the
manifest and loader tool automatically.

When a skill is loaded:

- String instructions are used directly; function instructions are awaited.
- Resources are appended under a `Resources` section.
- Bundled tools become available after load.
- Local skills stay cached indefinitely by registry identity.
- Remote skills use the configured cache TTL.

If a durable session resumes after a skill was loaded, the loaded instructions
remain in history. A fresh agent over the same messages can re-register tools
from the load result for resume safety.

## Prompt Design

A good skill is easy for the model to recognize and cheap to ignore:

- Use a concrete name such as `incident-review` or `support-writing`.
- Put the routing clue in the description.
- Keep instructions focused on repeatable decisions and style rules.
- Put long reference material in resources instead of the base description.
- Bundle only tools that are specific to the skill.
- Avoid overlapping skills with vague names such as `general` or `advanced`.

## Example: Skill-Gated Tool Use

This example keeps a refund lookup tool out of the default tool list until the
model loads the support policy skill.

```ts
import { agent } from 'fino:ai/agent';
import { openai } from 'fino:ai/model';
import { skill, skillRegistry } from 'fino:ai/skill';
import { tool } from 'fino:ai/tool';
import { v } from 'fino:validate';

const lookupRefundWindow = tool({
  name: 'lookup_refund_window',
  description: 'Return the refund window for a product plan.',
  parameters: v.object({
    plan: v.enum(['starter', 'business', 'enterprise']).describe('Customer plan'),
  }),
  execute: async ({ plan }: { plan: 'starter' | 'business' | 'enterprise' }) => {
    if (plan === 'enterprise') return 'Enterprise refunds require contract review.';
    return 'Refunds are available for 30 days.';
  },
});

const registry = skillRegistry([
  skill({
    name: 'refund-policy',
    description: 'Use when answering refund eligibility or refund-window questions.',
    instructions: 'Answer refund questions from policy. Ask for plan when missing.',
    tools: { lookupRefundWindow },
  }),
]);

const bot = agent({
  model: openai({ model: 'gpt-4o' }),
  skills: registry,
});

const result = await bot.generate('Can our enterprise customer get a refund?');
console.log(result.text);
```

Skills are most valuable when they keep the default agent compact while making
specialized behavior discoverable at the moment it is needed.
