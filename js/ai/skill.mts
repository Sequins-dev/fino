/**
 * Skill registry for lazy agent capabilities.
 *
 * A skill packages instructions, resources, and tools behind a small manifest.
 * Agents with a registry receive a loader tool so they can pull in only the
 * skill instructions and tools needed for the current task.
 */

import { tool } from 'fino:ai/tool';
import type { Tool } from 'fino:ai/tool';

/**
 * Named resource bundled with a skill.
 */
export interface SkillResource {
  name: string;
  content: string | (() => Promise<string>);
}

/**
 * Lazy-loadable agent capability.
 */
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly instructions: string | (() => Promise<string>);
  readonly tools: Record<string, Tool>;
  readonly resources: SkillResource[];
}

/**
 * Registry of skills available to an agent.
 */
export interface SkillRegistry {
  add(...skills: Skill[]): this;
  manifest(): { name: string; description: string }[];
  load(name: string): Promise<{ instructions: string; tools: Record<string, Tool> }>;
  asLoaderTool(): Tool;
}

/**
 * Create a skill definition.
 */
export function skill(def: {
  name: string;
  description: string;
  instructions: string | (() => Promise<string>);
  tools?: Record<string, Tool>;
  resources?: SkillResource[];
}): Skill {
  return {
    name: def.name,
    description: def.description,
    instructions: def.instructions,
    tools: def.tools ?? {},
    resources: def.resources ?? [],
  };
}

class SkillRegistryImpl implements SkillRegistry {
  #skills: Map<string, Skill> = new Map();
  #cache: Map<string, { instructions: string; tools: Record<string, Tool> }> = new Map();

  constructor(initial?: Skill[]) {
    for (const s of initial ?? []) {
      this.#skills.set(s.name, s);
    }
  }

  add(...skills: Skill[]): this {
    for (const s of skills) {
      this.#skills.set(s.name, s);
    }
    return this;
  }

  manifest(): { name: string; description: string }[] {
    return Array.from(this.#skills.values()).map((s) => ({
      name: s.name,
      description: s.description,
    }));
  }

  async load(name: string): Promise<{ instructions: string; tools: Record<string, Tool> }> {
    const cached = this.#cache.get(name);
    if (cached) return cached;

    const s = this.#skills.get(name);
    if (!s) throw new Error(`Unknown skill: ${name}`);

    let instructions =
      typeof s.instructions === 'string' ? s.instructions : await s.instructions();
    if (s.resources.length > 0) {
      const resourceBlocks: string[] = [];
      for (const resource of s.resources) {
        const content = typeof resource.content === 'string'
          ? resource.content
          : await resource.content();
        resourceBlocks.push(`### ${resource.name}\n\n${content}`);
      }
      instructions += `\n\n## Resources\n\n${resourceBlocks.join('\n\n')}`;
    }
    const result = { instructions, tools: s.tools };
    this.#cache.set(name, result);
    return result;
  }

  asLoaderTool(): Tool {
    return tool({
      name: 'load_skill',
      description:
        'Load a skill by name to access its full instructions and specialized tools. Call this when you need expertise from a skill listed in the available skills.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The name of the skill to load' },
        },
        required: ['name'],
      },
      execute: async (args: { name: string }) => {
        const loaded = await this.load(args.name);
        return loaded.instructions;
      },
    });
  }
}

/**
 * Create a registry of skills that an agent can load on demand.
 */
export function skillRegistry(skills?: Skill[]): SkillRegistry {
  return new SkillRegistryImpl(skills);
}
