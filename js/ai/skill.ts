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
const DEFAULT_REMOTE_CACHE_TTL_MS = 5 * 60 * 1e3;
const remoteState = Symbol('remoteSkillState');
/**
* Named resource bundled with a skill.
*
* When a skill is loaded, every resource is resolved and appended to the
* skill's instructions under a `## Resources` heading, each as its own
* `### name` section. Because resolution only happens at load time, resources
* are a good place for large reference material that should not weigh on the
* agent until the skill is actually needed.
*
* ```ts no_run
* import { skill } from 'fino:ai/skill';
*
* const research = skill({
*   name: 'research',
*   description: 'Research briefing workflow.',
*   instructions: 'Summarize the brief before proposing next steps.',
*   resources: [
*     { name: 'style.md', content: '# Style\nWrite in plain language.' },
*     {
*       name: 'brief.md',
*       content: async () => (await fetch('https://example.com/brief.md')).text(),
*     },
*   ],
* });
* ```
*/
export interface SkillResource {
  /**
  * Heading the resource content is filed under in the loaded instructions.
  */
  name: string;
  /**
  * Resource text, either inline or produced lazily when the skill loads.
  *
  * A function form is awaited once per registry cache entry; concurrent
  * loads of the same skill share the result.
  */
  content: string | (() => Promise<string>);
}
/**
* Lazy-loadable agent capability.
*
* Only `name` and `description` are surfaced to an agent up front (via the
* registry manifest); `instructions`, `resources`, and `tools` stay dormant
* until the skill is loaded. Construct skills with `skill()` rather than
* implementing this interface by hand — remote skills carry internal state
* that only `skill()` wires up.
*
* ```ts no_run
* import { skill, skillRegistry } from 'fino:ai/skill';
* import type { Skill } from 'fino:ai/skill';
*
* const reviewer: Skill = skill({
*   name: 'review',
*   description: 'Code-review checklist and tone.',
*   instructions: async () => 'Point out risky changes before style nits.',
* });
*
* const registry = skillRegistry([reviewer]);
* ```
*/
export interface Skill {
  /**
  * Unique identifier the agent passes to `load_skill`.
  *
  * For remote skills this starts as the repo name and may be replaced by
  * the fetched frontmatter's `name` after the first load.
  */
  readonly name: string;
  /**
  * Short summary shown in the agent's system prompt before the skill loads.
  *
  * This is the model's only signal for deciding whether to load the skill,
  * so make it concrete about when the skill applies.
  */
  readonly description: string;
  /**
  * Full guidance revealed when the skill is loaded.
  *
  * A function form is awaited lazily at load time, which is how remote
  * skills defer their network fetch.
  */
  readonly instructions: string | (() => Promise<string>);
  /**
  * Tools the agent registers once the skill is loaded.
  *
  * Remote skills always have an empty tool map — markdown fetched from a
  * repository never yields executable code.
  */
  readonly tools: Record<string, Tool>;
  /**
  * Reference material appended to the instructions at load time.
  */
  readonly resources: SkillResource[];
}
/**
* Options for SkillsMD-backed remote skills.
*
* All fields are optional; the defaults talk to the public SkillsMD API with
* the global `fetch` and a five-minute instruction cache.
*
* ```ts no_run
* import { skill } from 'fino:ai/skill';
*
* const remote = skill({
*   repo: 'acme/support-writing',
*   skillsmd: {
*     apiBaseUrl: 'https://skillsmd.internal/api',
*     cacheTtlMs: 60_000,
*   },
* });
* ```
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
*
* Pass a registry as `skills` when constructing an agent: the agent puts
* `manifest()` in its system prompt, registers `asLoaderTool()` so the model
* can pull skills in on demand, and calls `load()` to re-register bundled
* tools for any `load_skill` calls it finds in resumed message history.
*
* Load results are cached per registry. Local skills are cached for the
* registry's lifetime; remote skills expire after their configured TTL.
* Concurrent loads of the same skill share one in-flight promise, and a
* failed load is evicted so the next attempt retries from scratch.
*
* ```ts no_run
* import { skill, skillRegistry } from 'fino:ai/skill';
*
* const registry = skillRegistry()
*   .add(skill({
*     name: 'billing',
*     description: 'Refund and invoice policies.',
*     instructions: 'Never promise a refund without an order id.',
*   }))
*   .add(skill({ repo: 'acme/support-writing' }));
*
* registry.manifest(); // [{ name: 'billing', ... }, { name: 'support-writing', ... }]
* const { instructions, tools } = await registry.load('billing');
* ```
*/
export interface SkillRegistry {
  /**
  * Register additional skills, replacing any existing skill with the same
  * name. Returns the registry so calls can be chained.
  */
  add(...skills: Skill[]): this;
  /**
  * List the name and description of every registered skill — the only
  * metadata an agent sees before loading.
  *
  * Remote skills that have not been loaded yet report placeholder metadata
  * derived from their repo identifier; their entries update once a load
  * fetches the real frontmatter.
  */
  manifest(): {
    name: string;
    description: string;
  }[];
  /**
  * Resolve a skill to its full instructions (resources appended) and
  * bundled tools, fetching remote markdown if needed.
  *
  * Throws if no skill with that name is registered, and rejects if a remote
  * skill's markdown cannot be fetched or parsed.
  */
  load(name: string): Promise<{
    instructions: string;
    tools: Record<string, Tool>;
  }>;
  /**
  * Build the `load_skill` tool the agent exposes to the model.
  *
  * The tool takes a skill name, delegates to `load()`, and returns the
  * loaded instructions as its result; the agent runtime takes care of
  * registering the skill's bundled tools for subsequent steps.
  */
  asLoaderTool(): Tool;
}
/**
* Local skill definition accepted by `skill()`.
*
* Everything about a local skill is supplied in code: metadata, instructions
* (inline or lazy), and optionally executable tools and resources.
*
* ```ts no_run
* import { skill } from 'fino:ai/skill';
* import { tool } from 'fino:ai/tool';
* import { v } from 'fino:validate';
*
* const deploys = skill({
*   name: 'deploys',
*   description: 'Rollout and rollback procedures.',
*   instructions: 'Check the error budget before any rollout.',
*   tools: {
*     rollback: tool({
*       name: 'rollback',
*       description: 'Roll a service back to the previous release.',
*       parameters: v.object({ service: v.string() }),
*       execute: async ({ service }) => `rolled back ${service}`,
*     }),
*   },
* });
* ```
*/
export interface LocalSkillDefinition {
  /**
  * Unique skill name; also the argument agents pass to `load_skill`.
  */
  name: string;
  /**
  * One-line summary shown in the agent's system prompt.
  */
  description: string;
  /**
  * Full guidance, inline or produced lazily when the skill first loads.
  */
  instructions: string | (() => Promise<string>);
  /**
  * Tools registered with the agent once the skill loads. Defaults to none.
  */
  tools?: Record<string, Tool>;
  /**
  * Reference material appended to the instructions at load time.
  */
  resources?: SkillResource[];
}
/**
* SkillsMD-backed remote skill definition accepted by `skill()`.
*
* Only `repo` is required. The skill appears in the registry manifest
* immediately with placeholder metadata and fetches the repository's skill
* markdown on first load. Instructions are the markdown body below the YAML
* frontmatter; remote skills never carry executable tools or resources.
*
* ```ts no_run
* import { skill } from 'fino:ai/skill';
*
* const remote = skill({
*   repo: 'acme/support-writing',
*   description: 'House style for support replies.',
* });
* ```
*/
export interface RemoteSkillDefinition {
  /**
  * GitHub `owner/repo` identifier of the skill repository.
  *
  * Must be a bare identifier — URLs and extra path segments are rejected.
  */
  repo: string;
  /**
  * Manifest name override. When omitted, the repo name is used until the
  * fetched frontmatter supplies one; when set, frontmatter never replaces it.
  */
  name?: string;
  /**
  * Manifest description override. Same precedence as `name`: an explicit
  * value is never replaced by fetched metadata.
  */
  description?: string;
  /**
  * Transport and caching options for the SkillsMD fetch.
  */
  skillsmd?: SkillsMdOptions;
}
type SkillInternal = Skill & {
  [remoteState]?: {
    repo: string;
    explicitName: boolean;
    explicitDescription: boolean;
    cacheTtlMs: number;
    setMetadata(meta: {
      name?: string;
      description?: string;
    }): void;
  };
};
interface RemoteSkillMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validateRepoIdentifier(repo: string): {
  owner: string;
  name: string;
  repo: string;
} {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('SkillsMD repo must be an owner/repo identifier');
  }
  const [owner, name] = repo.split('/') as [string, string];
  return {
    owner,
    name,
    repo
  };
}
function frontmatterMarkdown(markdown: string): RemoteSkillMarkdown | null {
  const normalized = markdown.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) return null;
  const parsed = parseYaml(match[1] ?? '');
  if (!isRecord(parsed)) throw new Error('SkillsMD skill frontmatter must be a YAML mapping');
  return {
    frontmatter: parsed,
    body: match[2] ?? ''
  };
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
async function fetchGithubSkillMarkdown(fetchImpl: typeof globalThis.fetch, owner: string, repo: string): Promise<string | null> {
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
async function loadRemoteSkill(repoId: string, opts: SkillsMdOptions, setMetadata: (meta: {
  name?: string;
  description?: string;
}) => void): Promise<string> {
  const { owner, name: repoName, repo } = validateRepoIdentifier(repoId);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('SkillsMD skill loading requires fetch');
  const apiBase = (opts.apiBaseUrl ?? DEFAULT_SKILLSMD_API_BASE_URL).replace(/\/+$/, '');
  const detailRes = await fetchImpl(`${apiBase}/skill?repo=${encodeURIComponent(repo)}`);
  if (!detailRes.ok) throw new Error(`SkillsMD API request failed for ${repo}: HTTP ${detailRes.status}`);
  const detail = await detailRes.json();
  const directMarkdown = firstString(detail, [
    'skill',
    'skillMarkdown',
    'markdown',
    'content'
  ]);
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
    description: typeof parsed.frontmatter.description === 'string' ? parsed.frontmatter.description : firstString(detail, ['description'])
  });
  return parsed.body.trim();
}
/**
* Create a skill definition.
*
* A definition with a `repo` field builds a remote SkillsMD skill; anything
* else is a local skill. Local skills are returned essentially as given, with
* `tools` and `resources` defaulting to empty. Remote skills defer all network
* work to load time: loading queries the SkillsMD API, falls back to the
* repository's `skill.md`/`SKILL.md` via the GitHub contents API, then to a
* README with frontmatter, and rejects if no frontmattered markdown is found
* anywhere.
*
* Throws immediately if a remote `repo` is not a bare `owner/repo` identifier.
*
* ```ts no_run
* import { skill } from 'fino:ai/skill';
*
* const local = skill({
*   name: 'triage',
*   description: 'Incident triage steps.',
*   instructions: async () => 'Page the on-call before mitigating.',
* });
*
* const remote = skill({ repo: 'acme/incident-runbooks' });
* ```
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
      setMetadata(meta: {
        name?: string;
        description?: string;
      }): void {
        if (!explicitName && meta.name) name = meta.name;
        if (!explicitDescription && meta.description) description = meta.description;
      }
    };
    const remoteSkill: SkillInternal = {
      get name() {
        return name;
      },
      get description() {
        return description;
      },
      instructions: () => loadRemoteSkill(repo, skillsmd, state.setMetadata),
      tools: {},
      resources: [],
      [remoteState]: state
    };
    return remoteSkill;
  }
  return {
    name: def.name,
    description: def.description,
    instructions: def.instructions,
    tools: def.tools ?? {},
    resources: def.resources ?? []
  };
}
class SkillRegistryImpl implements SkillRegistry {
  #skills: Map<string, Skill> = new Map();
  #cache: Map<string, {
    expiresAt: number;
    promise: Promise<{
      instructions: string;
      tools: Record<string, Tool>;
    }>;
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
  manifest(): {
    name: string;
    description: string;
  }[] {
    return Array.from(this.#skills.values()).map((s) => ({
      name: s.name,
      description: s.description
    }));
  }
  async load(name: string): Promise<{
    instructions: string;
    tools: Record<string, Tool>;
  }> {
    const now = Date.now();
    const cached = this.#cache.get(name);
    if (cached && cached.expiresAt > now) return cached.promise;
    if (cached) this.#cache.delete(name);
    const s = this.#skills.get(name);
    if (!s) throw new Error(`Unknown skill: ${name}`);
    const state = (s as SkillInternal)[remoteState];
    const expiresAt = state ? now + state.cacheTtlMs : Number.POSITIVE_INFINITY;
    const promise = (async () => {
      let instructions = typeof s.instructions === 'string' ? s.instructions : await s.instructions();
      if (s.resources.length > 0) {
        const resourceBlocks: string[] = [];
        for (const resource of s.resources) {
          const content = typeof resource.content === 'string' ? resource.content : await resource.content();
          resourceBlocks.push(`### ${resource.name}\n\n${content}`);
        }
        instructions += `\n\n## Resources\n\n${resourceBlocks.join('\n\n')}`;
      }
      return {
        instructions,
        tools: s.tools
      };
    })();
    this.#cache.set(name, {
      expiresAt,
      promise
    });
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
      description: 'Load a skill by name to access its full instructions and specialized tools. Call this when you need expertise from a skill listed in the available skills.',
      parameters: v.object({ name: v.string().describe('The name of the skill to load') }),
      execute: async (args: {
        name: string;
      }) => {
        const loaded = await this.load(args.name);
        return loaded.instructions;
      }
    });
  }
}
/**
* Create a registry of skills that an agent can load on demand.
*
* The optional initial list can be extended later with `add()`. Local and
* remote skills mix freely in one registry and load through the same
* `load_skill` tool.
*
* ```ts no_run
* import { agent } from 'fino:ai/agent';
* import { openai } from 'fino:ai/model';
* import { skill, skillRegistry } from 'fino:ai/skill';
*
* const registry = skillRegistry([
*   skill({
*     name: 'billing',
*     description: 'Refund and invoice policies.',
*     instructions: 'Never promise a refund without an order id.',
*   }),
* ]);
*
* const bot = agent({ model: openai({ model: 'gpt-4o' }), skills: registry });
* ```
*/
export function skillRegistry(skills?: Skill[]): SkillRegistry {
  return new SkillRegistryImpl(skills);
}
