/**
 * fino:ai/skill — lazy instructions, resources, and tools for agents.
 *
 * Skills package optional capabilities behind a manifest. An agent configured
 * with a `SkillRegistry` sees only each skill's name and description in its
 * system prompt, then can call the generated `load_skill` tool to fetch the
 * full instructions, resources, and bundled tools when they are relevant.
 *
 * ## Design
 *
 * This keeps large or specialized instructions out of the default prompt while
 * preserving discoverability. Skill instructions and resources may be static or
 * loaded lazily. Tool definitions bundled with a skill are registered after the
 * skill is loaded, and a fresh agent over the same messages can re-register
 * those tools from the load result for resume safety.
 *
 * Remote SkillsMD skills use the same registry path as local skills. A skill
 * declared with `repo: 'owner/repo'` appears in the manifest immediately using
 * placeholder metadata, then fetches and parses the repository's skill markdown
 * only when `load_skill` asks for it.
 *
 * Skills are not a sandbox or trust boundary. Only register skills from code
 * you trust, and treat loaded instructions as part of the prompt surface.
 *
 * ```ts no_run
 * import { agent } from 'fino:ai/agent';
 * import { openai } from 'fino:ai/model';
 * import { skill, skillRegistry } from 'fino:ai/skill';
 *
 * const registry = skillRegistry([
 *   skill({
 *     name: 'support',
 *     description: 'Support-ticket writing guidance.',
 *     instructions: 'Ask for missing account details before promising refunds.',
 *     tools: {},
 *   }),
 *   skill({ repo: 'acme/support-writing' }),
 * ]);
 *
 * const bot = agent({ model: openai({ model: 'gpt-4o' }), skills: registry });
 * ```
 */

import { tool } from 'fino:ai/tool';
import type { Tool } from 'fino:ai/tool';
import { v } from 'fino:validate';
import { parse as parseYaml } from 'fino:format/yaml';

const DEFAULT_SKILLSMD_API_BASE_URL = 'https://skillsmd.dev/api';
const DEFAULT_REMOTE_CACHE_TTL_MS = 5 * 60 * 1000;
const remoteState = Symbol('remoteSkillState');

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
 * Options for SkillsMD-backed remote skills.
 */
export interface SkillsMdOptions {
  /**
   * Base URL for the SkillsMD API.
   *
   * Defaults to `https://skillsmd.dev/api`.
   */
  apiBaseUrl?: string;
  /**
   * Fetch implementation used for SkillsMD and GitHub requests.
   *
   * Tests and embedded runtimes can inject a custom implementation.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Registry cache duration for loaded remote skill instructions.
   *
   * Defaults to five minutes. Local skills continue to use the registry's
   * normal stable cache.
   */
  cacheTtlMs?: number;
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
 * Local skill definition accepted by `skill()`.
 */
export interface LocalSkillDefinition {
  name: string;
  description: string;
  instructions: string | (() => Promise<string>);
  tools?: Record<string, Tool>;
  resources?: SkillResource[];
}

/**
 * SkillsMD-backed remote skill definition accepted by `skill()`.
 */
export interface RemoteSkillDefinition {
  repo: string;
  name?: string;
  description?: string;
  skillsmd?: SkillsMdOptions;
}

type SkillInternal = Skill & {
  [remoteState]?: {
    repo: string;
    explicitName: boolean;
    explicitDescription: boolean;
    cacheTtlMs: number;
    setMetadata(meta: { name?: string; description?: string }): void;
  };
};

interface RemoteSkillMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateRepoIdentifier(repo: string): { owner: string; name: string; repo: string } {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('SkillsMD repo must be an owner/repo identifier');
  }
  const [owner, name] = repo.split('/') as [string, string];
  return { owner, name, repo };
}

function frontmatterMarkdown(markdown: string): RemoteSkillMarkdown | null {
  const normalized = markdown.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) return null;
  const parsed = parseYaml(match[1] ?? '');
  if (!isRecord(parsed)) throw new Error('SkillsMD skill frontmatter must be a YAML mapping');
  return { frontmatter: parsed, body: match[2] ?? '' };
}

async function jsonOrNull(res: Response): Promise<unknown> {
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function firstString(obj: unknown, keys: string[]): string | undefined {
  if (!isRecord(obj)) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function decodeGithubContent(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.content === 'string') {
    if (value.encoding === 'base64') return atob(value.content.replace(/\s+/g, ''));
    return value.content;
  }
  if (typeof value.download_url === 'string') return null;
  return null;
}

async function fetchGithubSkillMarkdown(
  fetchImpl: typeof globalThis.fetch,
  owner: string,
  repo: string,
): Promise<string | null> {
  for (const filename of ['skill.md', 'SKILL.md']) {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/contents/${filename}`);
    const json = await jsonOrNull(res);
    const decoded = decodeGithubContent(json);
    if (decoded !== null) return decoded;
    if (isRecord(json) && typeof json.download_url === 'string') {
      const raw = await fetchImpl(json.download_url);
      if (raw.ok) return raw.text();
    }
  }
  return null;
}

async function loadRemoteSkill(
  repoId: string,
  opts: SkillsMdOptions,
  setMetadata: (meta: { name?: string; description?: string }) => void,
): Promise<string> {
  const { owner, name: repoName, repo } = validateRepoIdentifier(repoId);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('SkillsMD skill loading requires fetch');
  const apiBase = (opts.apiBaseUrl ?? DEFAULT_SKILLSMD_API_BASE_URL).replace(/\/+$/, '');
  const detailRes = await fetchImpl(`${apiBase}/skill?repo=${encodeURIComponent(repo)}`);
  if (!detailRes.ok) throw new Error(`SkillsMD API request failed for ${repo}: HTTP ${detailRes.status}`);
  const detail = await detailRes.json();

  const directMarkdown = firstString(detail, ['skill', 'skillMarkdown', 'markdown', 'content']);
  let parsed = directMarkdown ? frontmatterMarkdown(directMarkdown) : null;
  if (!parsed) {
    const githubMarkdown = await fetchGithubSkillMarkdown(fetchImpl, owner, repoName);
    parsed = githubMarkdown ? frontmatterMarkdown(githubMarkdown) : null;
  }
  if (!parsed) {
    const readme = firstString(detail, ['readme', 'README']);
    parsed = readme ? frontmatterMarkdown(readme) : null;
  }
  if (!parsed) throw new Error(`No skill markdown found for ${repo}`);

  setMetadata({
    name: typeof parsed.frontmatter.name === 'string' ? parsed.frontmatter.name : undefined,
    description: typeof parsed.frontmatter.description === 'string'
      ? parsed.frontmatter.description
      : firstString(detail, ['description']),
  });
  return parsed.body.trim();
}

/**
 * Create a skill definition.
 */
export function skill(def: LocalSkillDefinition | RemoteSkillDefinition): Skill {
  if ('repo' in def) {
    const repo = validateRepoIdentifier(def.repo).repo;
    let name = def.name ?? repo.split('/')[1]!;
    let description = def.description ?? `SkillsMD skill from ${repo}`;
    const explicitName = def.name !== undefined;
    const explicitDescription = def.description !== undefined;
    const skillsmd = def.skillsmd ?? {};
    const state = {
      repo,
      explicitName,
      explicitDescription,
      cacheTtlMs: skillsmd.cacheTtlMs ?? DEFAULT_REMOTE_CACHE_TTL_MS,
      setMetadata(meta: { name?: string; description?: string }): void {
        if (!explicitName && meta.name) name = meta.name;
        if (!explicitDescription && meta.description) description = meta.description;
      },
    };
    const remoteSkill: SkillInternal = {
      get name() { return name; },
      get description() { return description; },
      instructions: () => loadRemoteSkill(repo, skillsmd, state.setMetadata),
      tools: {},
      resources: [],
      [remoteState]: state,
    };
    return remoteSkill;
  }
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
  #cache: Map<string, {
    expiresAt: number;
    promise: Promise<{ instructions: string; tools: Record<string, Tool> }>;
  }> = new Map();

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
    const now = Date.now();
    const cached = this.#cache.get(name);
    if (cached && cached.expiresAt > now) return cached.promise;
    if (cached) this.#cache.delete(name);

    const s = this.#skills.get(name);
    if (!s) throw new Error(`Unknown skill: ${name}`);

    const state = (s as SkillInternal)[remoteState];
    const expiresAt = state ? now + state.cacheTtlMs : Number.POSITIVE_INFINITY;
    const promise = (async () => {
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
      return { instructions, tools: s.tools };
    })();
    this.#cache.set(name, { expiresAt, promise });
    try {
      return await promise;
    } catch (err) {
      if (this.#cache.get(name)?.promise === promise) this.#cache.delete(name);
      throw err;
    }
  }

  asLoaderTool(): Tool {
    return tool({
      name: 'load_skill',
      description:
        'Load a skill by name to access its full instructions and specialized tools. Call this when you need expertise from a skill listed in the available skills.',
      parameters: v.object({
        name: v.string().describe('The name of the skill to load'),
      }),
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
