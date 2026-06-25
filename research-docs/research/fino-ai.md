# fino:ai — Agent & Harness Framework

> Status: design and API-shaping document. The phased roadmap below is the
> proposed implementation order. Specific TypeScript names are not frozen until
> the corresponding implementation phase is committed.

## 1. Goal

Add a first-class AI agent and harness framework to fino as a family of public
built-in modules under the `fino:ai` namespace. The framework should support:

- Autonomous **agents** — models that reason, decide which tools to call, and
  iterate toward a goal across multiple steps.
- A programmable **harness** — the driver that holds instructions, tools, and
  context and runs the reason→act→observe loop.
- Typed **tools** that validate their arguments at runtime and emit JSON Schema
  for the model.
- A provider-agnostic **model interface** with built-in Anthropic and
  OpenAI-compatible providers.
- **Memory** — conversation history, working memory, and semantic recall (RAG)
  over sqlite.
- **Durable sessions** — checkpointed, resumable conversations so a run
  survives a crash and a conversation is resumable from a previous invocation.
- **Workflows** — graph-based orchestration of multi-step processes.
- **Sandboxed execution** — capability-scoped tool and subagent code via the
  existing realm system.
- **Skills** — on-demand expertise units the model loads when relevant.
- **Channels** — headless transport adapters (HTTP, webhook, WebSocket).
- **Evals** — test-suite integration with optional Braintrust reporting.

The authoring style is **programmatic builders** (Mastra-style) — constructors
and factory functions, no filesystem-first magic in core. No new Rust is
required; the framework is overwhelmingly JS composition over existing fino
primitives.

## 2. Design influences

Three frameworks shaped the API surface:

**Mastra** — programmatic `new Agent({instructions, model, tools, memory})`,
`createTool({inputSchema, execute})`, graph workflows
(`.then/.branch/.parallel/.foreach/.dountil/.commit`), memory, evals/scorers,
OTel. Good model for the builder API and workflow composition.

**Flue** (Astro) — harness-first: a harness you populate with
instructions/tools/skills/sessions; the model drives autonomously. Durable
resumable sessions; skills loaded on demand; headless and programmable. Good
model for the harness/agent split and skill progressive disclosure.

**Eve** (Vercel) — checkpointed durable sessions; sandboxed compute; human-in-
the-loop approvals that pause at zero compute; subagents with isolated context
windows; multi-channel headless deployment; `defineEval`. Good model for the
session durability story and approval gates.

## 3. Existing fino foundations

fino already owns the primitives these frameworks bolt on externally. The entire
`fino:ai` stack maps onto verified existing modules.

| Concern | Existing module | Key surface |
|---|---|---|
| LLM transport + streaming | `fino:net/http/client` | `HttpClient.request({method,body,signal})`, `HttpResponse.body: AsyncIterable<Uint8Array>` |
| SSE framing (new) | `fino:net/http/eventstream` | `parseEventStream(bytes)`, `EventSourceReader`, `EventSourceWriter` |
| Tool/output schemas | `fino:validate` | `v.*` builders, `.schema` (= JSON Schema), `compile/safeParse`, `ValidationError` |
| Memory + vector search | `fino:database/sqlite` | `Database.open`, `transaction`, `vec()`/`vecDecode()`, `vectorsAvailable` |
| Durable checkpoint state | `internal:serializer` | V8 `serialize`/`deserialize` |
| Native sandbox + subagents | `fino:realm`, `fino:realm/pool` | `Realm`, `Realm.fromSource`, `ImportMap.deny`, `Facade`/`FacadeHandle`, `RealmPool` |
| Observability | `fino:opentelemetry` | `getTracerProvider`, `runWithActiveSpan`, OTel spans + topic-bus wiring |
| Agent event bus | `fino:context/topic` | `topic(name)`, `Topic.publish/subscribe/bindContext/runWithValue` |
| Per-run async context | `fino:context` | `Context<T>.runWithValue/get/snapshot` (CPED-backed) |
| Cancellation | global `AbortSignal`, loop | `AbortSignal.timeout/any`, `loop.run/spin({signal})` |
| HTTP channels | `fino:net/http/server`, `fino:net/http/app` | `serve()`; `HttpHandlerResult` (upgrade via return value) |
| Evals runner | `fino:test/test` | `test/suite/describe`, `TestContext` |

Module authoring pattern: add `js/ai/<x>.mts`, register
`source_builtin!("fino:ai/<x>", "ai/<x>")` in the `BUILTINS` array of
`src/loader.rs`. Mirror `js/context/index.mts` conventions: JSDoc, `#private`
fields, generics, no `DOMException`. Tests in `tests/ai-*.test.mts`.

## 4. Cross-cutting prerequisites

Three small changes are needed before the first `fino:ai` module can be written.
They each benefit the wider codebase, not just the agent framework.

### 4.1 fino:net/http/eventstream — lower-level SSE primitive

Anthropic and OpenAI stream responses as **POST requests with
`text/event-stream` response bodies**. The WHATWG `EventSource` is GET-only by
spec (`js/globals/eventsource.mts:1074` — literal `GET`, no body, redirects
forced to stay GET), so providers cannot use it.

Rather than a one-off internal helper, promote the SSE machinery to a new
public module `fino:net/http/eventstream` and layer `EventSource` on top:

- The SSE **parser** (`EventSourceReader`, `js/globals/eventsource.mts:261–423`)
  and **formatter** (`EventSourceWriter`, `:443–552`) are already fully
  transport-agnostic: they consume a generic `AsyncIterable<Uint8Array>` and
  have zero coupling to sockets, DNS, TLS, retry logic, or `Last-Event-ID`
  header construction. The line splitter `_lines` (`:1308`) is similarly pure.
- Move `EventSourceReader`, `EventSourceWriter`, `SseEvent`, `SseEventOptions`,
  `WriterLike`, and `_lines` into `js/net/http/eventstream.mts`.
- Add a thin factory: `parseEventStream(bytes: AsyncIterable<Uint8Array>):
  AsyncIterable<SseEvent>` — a one-line wrapper over `new EventSourceReader`.
- `js/globals/eventsource.mts` then imports `EventSourceReader` from the new
  module; the only coupling point (`:1145`) becomes a module import. Transport
  and reconnection logic stays in `eventsource.mts`.
- Keep the yielded field name `type` (don't churn the EventSource dispatch at
  `:1237`). Caveat: leave `EventSource`'s own `#lastEventId` null-vs-empty
  tracking independent of the reader's; don't unify in this pass.

After extraction, providers do:

```ts
import { parseEventStream } from 'fino:net/http/eventstream';
import { HttpClient } from 'fino:net/http/client';

const client = new HttpClient({ baseUrl: 'https://api.anthropic.com' });
const res = await client.request('/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
  body: JSON.stringify(wireRequest),
  signal,
});
for await (const evt of parseEventStream(res.body)) { /* ... */ }
```

This also benefits any other fine-grained HTTP consumer that needs SSE over
a non-GET request — it is the right primitive, not just a workaround.

### 4.2 SchemaBuilder.describe()

LLMs rely on per-field `description` to select correct arguments, but
`SchemaBuilder` has no `.describe()` method (verified — `js/validate.mts:665–815`
has only `toJSON`, `parse`, `safeParse`, `optional`, `nullable`, `default`,
`refine`).

Add a one-line mutator mirroring `.default()` (`validate.mts:791`):

```ts
describe(text: string): this {
  this.schema.description = text;
  return this;
}
```

JSON Schema `description` is already preserved by the validator (unknown
keywords are kept verbatim, `validate.mts:20–21`), so it round-trips into
tool `parameters` with zero impact on validation. This is also a direct win
for the **OpenAPI 3.1 generator** in `fino:net/http/app`: the generator emits
SchemaBuilder schemas verbatim via `cloneSchema` → `toJSON` (`app.mts:374`,
`577–586`, `1732`), so `.describe()` flows into Swagger/OpenAPI parameter and
response field descriptions for free — no change to `app.mts`.

Fallback if `fino:validate` is frozen in a given phase: a
`descriptions?: Record<string, string>` option on `tool()` that the tool layer
merges into the emitted JSON Schema properties.

### 4.3 Model interface contracts needed by later layers

Design `fino:ai/model` from the start with:

- `embed(texts: string[]): Promise<Float32Array[]>` + `readonly dimensions:
  number` — consumed by `fino:ai/memory` (RAG embeddings) and
  `fino:ai/eval`'s `semanticSimilarity` scorer.
- An optional `count(text: string): number` for token counting — consumed by
  `fino:ai/memory`'s `historyTokenBudget`; falls back to `chars / 4`.
- `Agent.step(): Promise<{messages, toolCalls?, done?, suspend?}>` — a
  single-step entry point the session layer calls and checkpoints between
  invocations.
- Dynamic mid-run tool registration so on-demand skills can extend the tool
  registry after a run starts.

## 5. Layer designs

### 5.1 fino:ai/model — provider-agnostic model interface

Normalized types:

```ts
type Role = 'user' | 'assistant' | 'system' | 'tool';
type ContentPart = TextPart | ImagePart | ToolUsePart | ToolResultPart;
interface ModelMessage { role: Role; content: string | ContentPart[]; }
interface GenerateRequest {
  messages: ModelMessage[];
  system?: string | (TextPart & { cache?: boolean })[];
  tools?: ToolDefinition[];                    // { name, description, parameters: JsonSchema }
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'tool'; name: string };
  temperature?: number; topP?: number; maxTokens?: number; stop?: string[];
  signal?: AbortSignal;
  responseFormat?: { type: 'json_schema'; schema: JsonSchema };
}
interface Usage {
  inputTokens: number; outputTokens: number;
  cacheReadInputTokens?: number; cacheWriteInputTokens?: number;
}
type StopReason = 'stop' | 'length' | 'tool_use' | 'content_filter' | 'error' | 'aborted';
type StreamEvent =
  | { type: 'text_delta'; text: string; index: number }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsTextDelta: string }
  | { type: 'tool_call_end'; index: number; input: unknown }
  | { type: 'usage'; usage: Usage }
  | { type: 'stop'; stopReason: StopReason }
  | { type: 'error'; error: Error };
interface ModelStream extends AsyncIterable<StreamEvent> {
  result(): Promise<GenerateResult>;
}
interface Model {
  readonly id: string; readonly provider: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream(req: GenerateRequest): ModelStream;
  embed(texts: string[]): Promise<Float32Array[]>;
  readonly dimensions: number;
}
```

Provider factories:

```ts
function anthropic(model: string, opts?: ProviderOptions): Model;
function openai(model: string, opts?: ProviderOptions): Model; // OpenAI-compatible
interface ProviderOptions {
  apiKey?: string;            // resolved from env if omitted
  baseUrl?: string;
  client?: HttpClient;        // DI for offline tests
  headers?: Record<string, string>;
  defaultModel?: string;
}
```

Both providers use `HttpClient.request({method:'POST', body, headers:{accept:'text/event-stream'}})` +
`parseEventStream` from `fino:net/http/eventstream`. `stream:true/false` are
separate code paths sharing a request builder and response normalizer.

Prompt caching: opt-in `cache: true` hints on `system` content parts →
Anthropic `cache_control: {type:'ephemeral'}`; OpenAI ignores (caching is
automatic). Usage always surfaces `cacheReadInputTokens`/`cacheWriteInputTokens`
(0 for providers that don't report it).

Exact Anthropic wire fields (`message_start`, `content_block_start`,
`content_block_delta` with `input_json_delta`, etc.) must be validated against
the **claude-api** skill before implementing the wire mapping in Phase 2.

OpenAI mapping: `tool_calls[].function.arguments` (incremental JSON string)
→ `tool_call_delta`; `finish_reason` → `StopReason`; `stream_options:
{include_usage:true}` for the final usage chunk.

### 5.2 fino:ai/tool — typed tool factory

```ts
function tool<Args, R extends ToolResult>(opts: {
  name: string;
  description: string;                          // required — drives model selection
  parameters: SchemaBuilder<Args> | JsonSchema; // fino:validate; .schema = JSON Schema
  execute: (args: Args, ctx: ToolRunContext) => R | Promise<R>;
}): Tool<Args, R>;

interface ToolRunContext {
  signal: AbortSignal;
  toolCallId: string;
  step: number;
  runId: string;
  messages: readonly ModelMessage[];
  emit?(event: unknown): void;
}
type ToolResult = string | { content: string | ContentPart[]; isError?: boolean };
```

`tool.invoke(rawArgs, ctx)`:
1. Validates `rawArgs` via a `compile(parameters)` validator (compiled once,
   reused). On failure: returns `{isError:true, content: validationSummary}` so
   the model self-corrects rather than crashing.
2. Calls `execute(parsedArgs, ctx)` with `ctx.signal` for cancellation.
3. Normalizes the return: `string` → text `tool_result`; object → pass-through;
   thrown error → `{isError:true}` (model-visible, agent continues); `AbortError`
   → rethrown (propagates up, run terminates).

`throwOnError` agent option opts into hard failures instead.

### 5.3 fino:ai/harness + fino:ai/agent — the reason→act→observe loop

`Harness` is the stateless-per-call driver. `Agent` is the ergonomic facade
that holds a configured `Harness` and normalizes input.

```ts
class Harness {
  constructor(opts: {
    model: Model;
    instructions?: string;
    tools?: Tool[];
    stopWhen?: StopCondition | StopCondition[];   // default: maxSteps(8)
    toolChoice?: ToolChoice;
    defaults?: Partial<Pick<GenerateRequest, 'temperature'|'topP'|'maxTokens'|'stop'>>;
    output?: SchemaBuilder | JsonSchema;           // structured-output mode
  });
  generate(input: RunInput): Promise<AgentResult>;
  stream(input: RunInput): AgentStream;
}

class Agent {
  constructor(opts: HarnessOptions & { name?: string });
  generate(input: string | RunInput): Promise<AgentResult>;
  stream(input: string | RunInput): AgentStream;
  step(state: HarnessState): Promise<StepResult>;    // durability contract
  asTool(opts: { name?: string; description: string; input?: SchemaBuilder }): Tool;
}

function agent(opts: AgentOptions): Agent; // factory

interface AgentResult {
  text: string;
  object?: unknown;          // structured-output mode
  messages: ModelMessage[];
  steps: HarnessState[];
  usage: Usage;
  stopReason: StopReason;
}
interface AgentStream extends AsyncIterable<StreamEvent> {
  result(): Promise<AgentResult>;
  text(): AsyncIterable<string>;
}
```

Loop per step:
1. Build `GenerateRequest` from accumulated messages + system (instructions) +
   tool definitions + defaults + `signal`.
2. Open a per-step OTel span. Call `model.stream(req)`. Fan `StreamEvent`s to
   the consumer stream; assemble via `.result()`.
3. Append the assistant turn to `messages`. Accumulate `Usage`.
4. If `stopReason !== 'tool_use'` → finalize.
5. Otherwise execute each `ToolUsePart` concurrently (`Promise.all`), each in
   its own `ai.tool` span, each given the run `signal`.
6. Append all `tool_result`s as a single `user` message. Evaluate `stopWhen`.
   Increment step and repeat.

**Structured output:** portable default is forced-tool — a synthetic `respond`
tool whose `input_schema` is the `output` schema, `toolChoice` pinned. Works
uniformly on Anthropic and OpenAI. Validated via `compile(output).safeParse`;
optional one-shot repair step on failure.

**Per-run context:** run executes inside `Context('fino:ai/run').runWithValue(
runState, () => loop())` so tools read run metadata via `Context.get()` across
`await` boundaries (CPED-backed, no explicit plumbing).

**Telemetry:** Direct OTel spans `ai.run → ai.step → ai.tool` via
`getTracerProvider().getTracer('fino:ai')` and `runWithActiveSpan`. Attributes:
`ai.model`, `ai.provider`, `ai.step`, `ai.stop_reason`, `ai.usage.input_tokens`,
`ai.usage.output_tokens`, `ai.usage.cache_read`, `ai.usage.cache_write`. Tool
spans: `ai.tool.name`, `ai.tool.call_id`; `recordException` on tool error.
Because spans publish to the topic-bus, any `OtelSDK` exporter captures them
without extra wiring. Additionally: `topic('fino:ai:event').publish({type,
runId, ...})` with `bindContext(runContext)` for app-level hooks independent of
OTel.

**`asTool()`** wraps `agent.generate` in a `tool()` for subagent composition.
Nested span context propagates automatically.

### 5.4 fino:ai/memory — history, working memory, semantic recall

`SqliteMemory` over `fino:database/sqlite`. Three concerns under one interface:

- **History** — `messages` table (content serialized via `internal:serializer`,
  indexed by `(thread_id, created_at)`).
- **Working memory** — `working_memory` table (serialized blob, upserted);
  a small mutable scratchpad the model rewrites (e.g. user profile, task state).
- **Semantic recall (RAG)** — `chunks` table + sqlite-vec virtual table;
  inserted via `vec(float32Array)`, KNN-queried for `topK` nearest neighbors;
  decoded (if needed) via `vecDecode`. Gated behind `vectorsAvailable`.

```ts
interface Memory {
  readonly threadId: string;
  append(msg: Omit<MemoryMessage, 'id'|'createdAt'|'threadId'>): Promise<MemoryMessage>;
  history(opts?: { last?: number; before?: number }): Promise<MemoryMessage[]>;
  recall(query: MemoryQuery): Promise<RecalledContext>;
  ingest(docs: { text: string; metadata?: Record<string, unknown> }[],
         opts?: { scope?: 'thread' | 'resource'; chunk?: ChunkOptions }): Promise<void>;
  getWorkingMemory(): Promise<Record<string, unknown> | null>;
  setWorkingMemory(patch: Record<string, unknown>, mode?: 'merge' | 'replace'): Promise<void>;
  thread(id: string): Memory;   // re-scope to another conversation, same store
}

class SqliteMemory implements Memory {
  static async open(opts: {
    path: string;
    embedder: Embedder;           // Model implements Embedder
    resourceId?: string;
    dimensions?: number;
    historyTokenBudget?: number;
    fs?: FileSystem;
  }): Promise<SqliteMemory>;
}

function memory(opts: SqliteMemoryOptions): Promise<Memory>;
```

`recall(query)` returns `{ messages, recalled: RecallHit[], workingMemory }` —
the single entry point the harness calls to hydrate context. Thread-scoped by
default; `scope:'resource'` widens recall across all threads of the same
`resourceId` for long-term cross-conversation memory. Graceful degradation when
`vectorsAvailable` is false (history + working only; `memory.semanticAvailable`
flag surfaced).

### 5.5 fino:ai/session — durable, resumable runs and conversations

The engine that runs an agent **one step at a time and checkpoints after each**.
Two distinct resume axes, both first-class:

**Crash/restart resume (within a run).** `RunState` is serialized via
`internal:serializer` into a `runs` sqlite row; each step wrapped in
`db.transaction` (atomic, never torn). Resume is **state reload, not action
replay** — applied tool results are already in `messages`, so no tool
re-execution. Optional per-tool idempotency key for at-most-once on
non-idempotent tools that crashed mid-flight.

**Conversation resume (across runs).** A conversation is a durable, long-lived
`threadId`. The full message sequence and step progress persist so a *later,
separate* invocation continues the same conversation from where it ended — not
just crash recovery. `Session` is constructed with a `threadId`; `start()`
restores the prior message sequence + `stepIndex` from the checkpoint store
(together with `fino:ai/memory` history/working-memory when a `Memory` is
attached). `store.list({threadId})` enumerates a thread's run history.

```ts
interface RunState {
  runId: string; threadId: string; status: RunStatus; stepIndex: number;
  messages: MemoryMessage[]; pending: PendingToolCall[];
  suspendedOn?: SuspendReason; scratch: Record<string, unknown>;
  result?: unknown; error?: { message: string; stack?: string };
}
class Session {
  constructor(opts: { store: CheckpointStore; memory?: Memory; agent: Agent;
    onCheckpoint?: (s: RunState) => void });
  static async resume(opts: SessionOptions & { runId: string }): Promise<Session>;
  start(input: unknown, opts?: { runId?: string }): Promise<RunResult>;
  resume(resumeToken: string, value: unknown): Promise<RunResult>;
  suspend(reason: SuspendReason): never;   // throw-based; caught by the loop
  cancel(): Promise<void>;
  readonly state: RunState;
}
function session(opts: SessionOptions): Session;
```

**Human-in-the-loop = zero-compute suspend.** An agent/tool throws a
`SuspendSignal`; the session loop catches it, sets `status='suspended'`,
persists, and **returns** — no timer, no held resources. The row sits in sqlite.
Later, `session.resume(resumeToken, value)` reloads, injects the value, flips
to `running`, and continues. Resume tokens are single-use (optional TTL).

### 5.6 fino:ai/workflow — graph orchestration

Mastra-style graph builder over the session layer:

```ts
function workflow<In, Out>(def: {
  id: string; inputSchema?: unknown; outputSchema?: unknown;
}): Workflow<In, Out>;

function step<In, Out>(def: {
  id: string; inputSchema?: unknown; outputSchema?: unknown;
  execute: (ctx: StepContext<In>) => Promise<Out>;
}): Step<In, Out>;

interface Workflow<In, Out> {
  then<O>(step: Step<any, O>): Workflow<In, O>;
  branch(arms: [Predicate<any>, Step<any, any>][]): Workflow<In, any>;
  parallel(steps: Step<any, any>[]): Workflow<In, any[]>;
  foreach<I, O>(step: Step<I, O>, opts?: { concurrency?: number }): Workflow<In, O[]>;
  dountil(step: Step<any, any>, cond: Predicate<any>): Workflow<In, any>;
  map(fn: (prev: any, ctx: StepContext<any>) => any): Workflow<In, any>;
  commit(): CompiledWorkflow<In, Out>;
}
```

`.commit()` freezes a serializable graph; `WorkflowRun` reuses `Session`
(`scratch.stepResults` holds per-node outputs; `stepIndex` = current graph
node), so every node boundary is a checkpoint and suspend/resume + approval
gates work for free. A per-branch completion bitmap in `scratch` ensures
`parallel`/`foreach` branches are not re-run after a crash. Steps may call
`Agent`s directly or open nested sessions.

### 5.7 fino:ai/sandbox — capability-scoped execution

Ergonomic wrapper over `fino:realm` + `ImportMap.deny` + `Facade`:

```ts
class Sandbox {
  constructor(opts?: {
    isolation?: 'thread' | 'process';   // default 'thread'
    capabilities?: Capability[];
    allowImports?: string[];
    timeoutMs?: number;
  });
  runSource<T>(source: string, ...args: unknown[]): Promise<T>;  // Realm.fromSource + call
  runEntry<T>(entry: string, ...args: unknown[]): Promise<T>;    // new Realm({entry}).call
  spawn(entry: string): SandboxHandle;    // long-lived; warm pool via RealmPool
  terminate(): Promise<void>;
}

// Built-in capability factories
function fsCapability(opts: { root: string; mode?: 'ro' | 'rw' }): Capability;
function netCapability(opts: { allowHosts: string[] }): Capability;
function modelCapability(model: Model): Capability;   // exposes model via Facade
function memoryCapability(mem: Memory): Capability;    // exposes thread-scoped Memory
function toolsCapability(tools: Record<string, Tool>): Capability;
```

Internally: `ImportMap.deny([...caps.flatMap(c => c.toRules()), ...allow])` —
block-all baseline with allowlist exceptions. Each `Capability` exposes its
host surface as a `Facade` on `realm.port`: streaming resources via
`Facade.stream()`, stateful handles via `FacadeHandle`.

**Subagents** — `spawn(agentEntry)` with `[modelCapability, memoryCapability,
toolsCapability]`. The child realm has its own V8 context + microtask isolation
(a physically separate context window); the parent passes a task via `call()`
and gets back a result. Warm subagent pools use `RealmPool({entry, size})`.

Note: `process`-mode ports cannot transfer live `MessagePort` objects;
capability payloads must be serializer-compatible.

### 5.8 fino:ai/skill — on-demand expertise

Progressive disclosure: only name + description are always in the system prompt
(minimal tokens); the instruction body loads on demand.

```ts
function skill(def: {
  name: string;
  description: string;
  instructions: string | (() => Promise<string>);   // lazy/file-backed
  tools?: Record<string, Tool>;
  resources?: SkillResource[];
}): Skill;

function skillRegistry(skills?: Skill[]): SkillRegistry;
interface SkillRegistry {
  add(...skills: Skill[]): this;
  manifest(): { name: string; description: string }[];  // for system prompt
  load(name: string): Promise<{ instructions: string; tools: Record<string, Tool> }>;
  asLoaderTool(): Tool;   // load_skill({name}) → appends instructions + registers tools
}
```

The harness injects `registry.manifest()` into the system prompt and adds
`registry.asLoaderTool()` to the tool set. When the model calls `load_skill`,
the harness fetches the skill body, appends it as a system/tool message (so it
persists in `RunState.messages` and survives resume), and dynamically extends
the active tool registry. Skill-bundled tools run inside a `Sandbox` so a
loaded skill cannot exceed the agent's capability allowlist.

### 5.9 fino:ai/channel — headless transport adapters

```ts
function httpChannel(driver: AgentDriver, opts?: {
  path?: string; app?: App;
}): Channel;                            // POST {threadId, text} → JSON reply

function webhookChannel(driver: AgentDriver, opts: {
  path: string; verify?: (req: Request) => boolean | Promise<boolean>;
}): Channel;                            // inbound webhook → fire-and-forget run

function websocketChannel(driver: AgentDriver, opts?: { path?: string }): Channel;
// WebSocket upgrade via the serve() handler return (HttpHandlerResult); streams tokens

interface AgentDriver {
  handle(msg: ChannelMessage): Promise<ChannelReply>;
  stream(msg: ChannelMessage): AsyncIterable<string>;
  resume(resumeToken: string, value: unknown): Promise<ChannelReply>;
}
```

`AgentDriver` is a thin adapter over a `Session`, so channel-driven runs are
durable and a suspended approval resumes via a later HTTP request carrying the
`resumeToken`. The WebSocket upgrade flows through the `serve()` handler return
value (first-class `HttpHandlerResult` — matching the runtime's stated
preference for protocol upgrades).

### 5.10 fino:ai/eval — evaluation suite

```ts
function evaluate<In, Out>(def: {
  name: string;
  target: (input: In) => Promise<Out>;
  cases: EvalCase<In, Out>[];
  scorers: Scorer<Out>[];
  threshold?: number;         // min mean score across all cases; default 1.0
  report?: EvalReporter;      // optional sink (e.g. Braintrust)
}): void;

// Built-in scorers
function exactMatch(): Scorer;
function contains(substr: string): Scorer;
function schemaScorer(schema: unknown): Scorer;                 // fino:validate
function llmJudge(model: Model, rubric: string): Scorer;
function semanticSimilarity(embedder: Embedder, min: number): Scorer;
```

`evaluate()` emits one `fino:test` `test()` per case plus a `suite()` summary,
so eval suites run under `fino --test` and CI with no new runner.

**Optional Braintrust integration** — an isolated submodule `fino:ai/eval/braintrust`:

```ts
import { braintrustReporter } from 'fino:ai/eval/braintrust';
evaluate({
  ...,
  report: braintrustReporter({ apiKey, project, experiment: 'v1.2' }),
});
```

The reporter logs each case's input/output/expected/scores to braintrust.dev
over `fino:net/http/client`. It is strictly opt-in — core evals have zero
Braintrust dependency; the local TAP path never imports `fino:ai/eval/braintrust`.

## 6. Phased roadmap

### Milestone A — Core (runnable agent, offline-testable)

**Phase 0 — Prerequisites**
- (a) Create `fino:net/http/eventstream`. Move `EventSourceReader`,
  `EventSourceWriter`, `SseEvent`, `SseEventOptions`, `WriterLike`, `_lines`
  from `js/globals/eventsource.mts` into `js/net/http/eventstream.mts`. Add
  `parseEventStream` wrapper. Update `js/globals/eventsource.mts` to import the
  reader (one line change at `:1145`). Verify existing EventSource tests pass.
- (b) Add `SchemaBuilder.describe(text)` to `fino:validate`. Add an OpenAPI
  test asserting the description surfaces in the generated document.

**Phase 1 — `fino:ai/model` types + interface**
Ship the message/content/request/event types and the `Model` interface. No
providers yet. Unit-test the delta→result assembler (pure function, no network).

**Phase 2 — Providers**
Implement `anthropic()` and `openai()` over `HttpClient.request` +
`parseEventStream`. Tests via injected `HttpClient` and canned SSE byte streams
— no live API calls. Cover `stream:true/false` paths, usage/cache accounting,
and tool-call framing.

**Phase 3 — `fino:ai/tool`**
Tool factory, JSON Schema emission via `.schema`, `safeParse` validation
feedback, error-to-tool-result normalization, `AbortError` pass-through.

**Phase 4 — `fino:ai/harness`**
The reason→act→observe loop: `stopWhen`/`maxSteps`, concurrent tool execution,
`Context<T>` run scope, cancellation. Test with a mock `Model` (scripted
tool-use turns) — fully offline.

**Phase 5 — Telemetry wiring**
`ai.run`/`ai.step`/`ai.tool` OTel spans + `fino:ai:event` topic with
`bindContext`. Assert span tree + attributes via `InMemoryExporter`.

**Phase 6 — `fino:ai/agent`**
Facade over `Harness`. Structured output (forced-tool strategy). `asTool()`
subagent composition. `AgentStream.text()`. End-to-end test with mock model.

### Milestone B — Stateful

**Phase 7 — `fino:ai/memory`**
History + working memory first; semantic recall behind `vectorsAvailable`.

**Phase 8 — `fino:ai/session`**
Durable checkpoint + both resume axes (crash/restart and cross-run conversation
continuation) + human-in-the-loop suspend. Tested by killing/restarting
mid-run and asserting correct resume; second test continues a completed
conversation in a new session.

### Milestone C — Orchestration

Phase 9 and 11 can start as soon as their dependencies are met; Phase 9 is
independent of Milestone B and can overlap with it.

**Phase 9 — `fino:ai/sandbox`**
Depends only on the already-shipped `fino:realm`. Tested by asserting a denied
import throws in a sandboxed realm and that a capability-gated Facade is
accessible.

**Phase 10 — `fino:ai/workflow`**
Graph builder over the session layer.

**Phase 11 — `fino:ai/skill`**
On-demand skill registry + `load_skill` tool + sandbox-gated execution.

### Milestone D — Edges

**Phase 12 — `fino:ai/channel` + `fino:ai/eval`**
Thin adapters. `fino:ai/eval/braintrust` reporter last (opt-in, no core
dependency).

## 7. Verification (per phase)

```
cargo build               # ensures builtins register without error
cargo run -- --test 'tests/ai-*.test.mts'   # TAP, exit 0
cargo clippy              # no warnings
cargo fmt --check
```

- Phase 0: existing EventSource tests pass; OpenAPI test asserts `.describe()`
  in the generated doc.
- Phases 1–6: offline only (mock Model, injected HttpClient). No live API keys
  in CI.
- Phase 5: `InMemoryExporter` asserts `ai.run → ai.step → ai.tool` span
  hierarchy and usage attributes.
- Phase 8: crash + resume test; cross-run conversation continuation test.
- Phase 9: sandboxed realm rejects a denied import; Facade capability is
  reachable.
