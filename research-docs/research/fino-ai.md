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
- **MCP integration** — MCP client transports and MCP tool adaptation into the
  same `Tool` registry used by agents.

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
| Durable checkpoint state | `JSON` + `fino:database/sqlite` | `JSON.stringify`/`parse` into sqlite `TEXT` rows |
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

One prerequisite remains before the first `fino:ai` module can be written
(`fino:net/http/eventstream` and `SchemaBuilder.describe()` are already
shipped).

### 4.1 Model interface contracts needed by later layers

Design `fino:ai/model` from the start with:

- `embed(texts: string[]): Promise<Float32Array[]>` + `readonly dimensions:
  number` — consumed by `fino:ai/memory` (RAG embeddings) and
  `fino:ai/eval`'s `semanticSimilarity` scorer.
- An optional `count(text: string): number` for token counting — consumed by
  `fino:ai/memory`'s `historyTokenBudget`; falls back to `chars / 4`.
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
  readonly id: string; readonly name: string; readonly provider: string;
  readonly capabilities?: { responseFormat?: boolean };
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

`Harness` is the stateless-per-call step driver. `Agent` is the ergonomic
facade that holds a configured `Harness` and normalizes input.

The two levels of entry point reflect the two usage modes:

- **`step(state)`** — executes exactly one reason→act→observe cycle (one model
  call + concurrent tool executions). Returns when tool results are assembled
  and appended to messages, or when the model emits a terminal stop reason.
  This is the primitive `Session` drives in its outer loop: call `step`, get
  back updated state, checkpoint, repeat.
- **`generate(input)` / `stream(input)`** — convenience methods that run the
  full multi-step loop internally (no checkpointing). Use these for stateless
  one-shot calls; use `Session` when durability matters.

```ts
interface HarnessState {
  messages: ModelMessage[];
  stepIndex: number;
  usage: Usage;
  signal?: AbortSignal;
}

interface StepResult {
  state: HarnessState;
  done: boolean;           // terminal stop reason reached
  suspend?: SuspendSignal; // tool threw SuspendSignal
  stopReason: StopReason;
}

class Harness {
  constructor(opts: {
    model: Model;
    instructions?: string;
    tools?: Tool[];
    stopWhen?: StopCondition | StopCondition[];   // default: maxSteps(8)
    toolChoice?: ToolChoice;
    defaults?: Partial<Pick<GenerateRequest, 'temperature'|'topP'|'maxTokens'|'stop'>>;
    output?: SchemaBuilder | JsonSchema;           // structured-output mode
    structuredOutputMode?: 'tool' | 'native';       // default: 'tool'
  });
  step(state: HarnessState): Promise<StepResult>;
  generate(input: RunInput): Promise<AgentResult>;
  stream(input: RunInput): AgentStream;
}

class Agent {
  constructor(opts: HarnessOptions & { name?: string });
  step(state: HarnessState): Promise<StepResult>;  // single inner-loop cycle
  generate(input: string | RunInput): Promise<AgentResult>;
  stream(input: string | RunInput): AgentStream;
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
interface AgentStream {
  reader: Reader<StreamEvent>;
  result: Promise<AgentResult>;
}
```

One `step()` cycle:
1. Build `GenerateRequest` from `state.messages` + system (instructions) +
   tool definitions + defaults + `state.signal`.
2. Open a per-step OTel span. Call `model.stream(req)`. Fan `StreamEvent`s to
   the consumer stream; assemble via `.result()`.
3. Append the assistant turn to `state.messages`. Accumulate `Usage`.
4. If `stopReason !== 'tool_use'` → return `{done: true, ...}`.
5. Otherwise execute each `ToolUsePart` concurrently (`Promise.all`), each in
   its own `ai.tool` span, each given `state.signal`.
6. If any tool threw `SuspendSignal` → return `{done: false, suspend, ...}`.
7. Append all `tool_result`s as a single `user` message. Evaluate `stopWhen`.
   Return `{done: stopWhen matched, state: updatedState}`.

`generate()` / `stream()` internally loop over `step()` until `done`, no
checkpoint. `Session` drives the same loop externally, checkpointing between
each `step()` call.

**Structured output:** portable default is forced-tool — a synthetic `respond`
tool whose `input_schema` is the `output` schema, `toolChoice` pinned. Works
uniformly across providers and remains the default even when a provider supports
native response formats. Native JSON Schema mode is opt-in via
`structuredOutputMode: 'native'` and only used when `model.capabilities` declares
support. Both modes validate through `fino:validate`; forced-tool mode keeps the
one-shot repair behavior.

**Agent streams:** `AgentStream` intentionally follows Fino's runtime stream
shape instead of being an `AsyncIterable` itself:

```ts
interface AgentStream {
  reader: Reader<StreamEvent>;
  result: Promise<AgentResult>;
}
```

Helpers such as `streamText(stream)` adapt the `Reader` when callers want text
chunks. This keeps AI streaming compatible with the rest of the runtime's
Reader/Writer primitives.

**Per-run context:** run executes inside `Context('fino:ai/run').runWithValue(
runState, () => loop())` so tools read run metadata via `Context.get()` across
`await` boundaries (CPED-backed, no explicit plumbing).

**Telemetry:** GenAI semantic conventions via
`getTracerProvider().getTracer('fino.ai')`. Spans: `invoke_agent` (run),
`chat {model}` (per step), `execute_tool {name}` (per tool call). Attributes:
`gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`,
`gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens/output_tokens`,
`gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`,
`gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`, `gen_ai.agent.name`
(when named), `gen_ai.conversation.id`; `error.type` on all error paths.
Metrics: `gen_ai.client.token.usage` (histogram, unit `{token}`, split by
`gen_ai.token.type`) and `gen_ai.client.operation.duration` (histogram, unit `s`).
Log event: `gen_ai.client.inference.operation.details` per chat step; message
content opt-in via `captureContent`. All signals publish over the topic-bus —
any `OtelSDK` exporter captures them without extra wiring.

**`asTool()`** wraps `agent.generate` in a `tool()` for subagent composition.
Nested span context propagates automatically.

### 5.4 fino:ai/memory — history, working memory, semantic recall

`SqliteMemory` over `fino:database/sqlite`. Three concerns under one interface:

- **History** — `messages` table (content as JSON `TEXT`, indexed by
  `(thread_id, created_at)`).
- **Working memory** — `working_memory` table (JSON `TEXT`, upserted); a small
  mutable scratchpad the model rewrites (e.g. user profile, task state).
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
the single entry point `Session` calls to hydrate context. The current user
input is passed as `query.text`; prior messages remain ordinary conversation
messages, while working memory and semantic hits are injected as a compact
system memory context. Thread-scoped by
default; `scope:'resource'` widens recall across all threads of the same
`resourceId` for long-term cross-conversation memory. Graceful degradation when
`vectorsAvailable` is false (history + working only; `memory.semanticAvailable`
flag surfaced).

### 5.5 fino:ai/session — durable, resumable runs and conversations

`Session` is the **loop of loops**: it drives `agent.step()` one iteration at
a time and checkpoints to sqlite after each completed step. The harness
(`Agent`) is stateless; all durability lives in `Session`.

```
Session.start() / Session.resume():
  while not done:
    result = await agent.step(currentState)    // one inner cycle
    db.transaction(() => save(result.state))   // checkpoint (atomic, never torn)
    if result.done or result.suspend: break
```

This gives per-step checkpoint granularity: only the current step is lost on a
crash, never prior steps. Two distinct resume axes, both first-class:

**Crash/restart resume (within a run).** `RunState` is serialized as JSON into
a `runs` sqlite `TEXT` column; each checkpoint is a transaction (atomic, never
torn). Resume is **state reload, not action replay** — applied tool results are
already in `messages`, so no tool re-execution. Optional per-tool idempotency
key for at-most-once on non-idempotent tools that crashed mid-flight.

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
  messages: ModelMessage[]; pending: PendingToolCall[];
  suspendedOn?: SuspendReason; scratch: Record<string, unknown>;
  result?: unknown; error?: { message: string; stack?: string };
}
class Session {
  constructor(opts: { store: CheckpointStore; memory?: Memory; agent: Agent;
    onCheckpoint?: (s: RunState) => void });
  static async resume(opts: SessionOptions & { runId: string }): Promise<Session>;
  static async resumeSuspended(opts: SessionOptions & {
    runId: string; resumeToken: string; value: unknown;
  }): Promise<RunResult>;
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
Channels and other stateless adapters should use `Session.resumeSuspended()`
with both `runId` and `resumeToken` so human approval survives process restart.

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

Suspension is allowed only from explicit top-level step nodes, which makes them
approval gates. Suspension from composite nodes (`parallel`, `foreach`,
`dountil`) is rejected with a clear error until resumable partial-composite
semantics are designed.

### 5.7 fino:ai/sandbox — capability-scoped execution *(deferred)*

> **Status: deferred.** This surface needs further design work. Agents and
> orchestration (phases 10–11) ship running in a privileged environment first;
> sandboxing is a later adaptation once the capability model is settled.

Planned ergonomic wrapper over `fino:realm` + `ImportMap.deny` + `Facade` —
block-all baseline with per-capability Facade allowlist exceptions, warm subagent
pools via `RealmPool`, and serializable capability payloads compatible with
both thread- and process-mode realms.

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
the registry resolves lazy instructions and resources, then the harness returns
that loaded content as the tool_result content (so it persists in
`RunState.messages` and survives resume). On each subsequent step
the harness scans message history for loaded-skill markers and re-derives the
active tool set — making skill state a pure function of messages (crash/cross-run
resume is automatic with no extra persistence). Skill-bundled tools currently
execute in the privileged environment; sandbox-gating is a future adaptation
(see §5.7).

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
  resume(input: { runId: string; resumeToken: string; value: unknown }): Promise<ChannelReply>;
}
```

`AgentDriver` is a thin adapter over a `Session`, so channel-driven runs are
durable and a suspended approval resumes via a later HTTP request carrying both
`runId` and `resumeToken`. Drivers with a `CheckpointStore` reload suspended
state from sqlite; the in-memory token map is only a stateless fallback. The
WebSocket upgrade flows through the `serve()` handler return value (first-class
`HttpHandlerResult` — matching the runtime's stated preference for protocol
upgrades).

### 5.11 fino:ai/mcp — MCP client and tool adaptation

`fino:ai/mcp` provides stdio and HTTP/SSE transports over `fino:jsonrpc`, an
`MCPClient` that performs the initialize handshake, lists tools/resources, reads
resources, and adapts MCP tools into `fino:ai/tool` instances. MCP tool schemas
flow through the same tool-definition path as local tools, so harness execution,
validation, telemetry, and tool-result normalization stay shared.

### 5.10 fino:ai/eval — evaluation suite

```ts
function evaluate<In, Out>(def: {
  name: string;
  target: (input: In) => Promise<Out>;
  cases: EvalCase<In, Out>[];
  scorers: Scorer<Out>[];
  threshold?: number;         // min mean score across all cases; default 1.0
  report?: EvalReporter;      // optional sink
}): void;

// Built-in scorers
function exactMatch(): Scorer;
function contains(substr: string): Scorer;
function schemaScorer(schema: unknown): Scorer;                 // fino:validate
function llmJudge(model: Model, rubric: string): Scorer;        // parses JSON text response
function semanticSimilarity(model: Model, min: number): Scorer; // model.embed cosine
```

`evaluate()` emits one `fino:test` `test()` per case plus a `suite()` summary,
so eval suites run under `fino --test` and CI with no new runner. Scorers expose
a `.scorerName` property used as the key in per-case `scores` maps.

**Subclassable reporter** — `EvalReporter` is an abstract base class with
lifecycle hooks (all default no-ops). The one shipped subclass is
`OpenTelemetryReporter`, which emits standard GenAI evaluation semconv:

```ts
import { OpenTelemetryReporter } from 'fino:ai/eval';

// With OTLP endpoint (e.g. Braintrust, Honeycomb, Phoenix, local collector):
evaluate({
  ...,
  report: new OpenTelemetryReporter({
    endpoint: 'https://api.braintrust.dev/otel',
    headers: {
      Authorization: 'Bearer <key>',
      'x-bt-parent': 'project_name:<project>',
    },
  }),
});

// Without endpoint: emits into the ambient OTel providers (no SDK started):
evaluate({ ..., report: new OpenTelemetryReporter() });
```

Per-case `onCase()` emits a `gen_ai.evaluation.result` log event per scorer
(with `gen_ai.evaluation.name`, `gen_ai.evaluation.score.value`,
`gen_ai.evaluation.score.label` = `pass`/`fail`, `gen_ai.evaluation.explanation`
when available) and records a `gen_ai.client.evaluation.score` histogram. When
`endpoint`/`exporter` is given, `onStart` starts an `OtelSDK` so the AI module's
gen-ai spans (from model calls inside `target`) also export to the same backend.
`onFinish` flushes + shuts down. Braintrust and any other OTLP backend are
reached by config — no vendor-specific module.

## 6. Phased roadmap

### Milestone A — Core (runnable agent, offline-testable)

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

**Phase 5 — Telemetry wiring** *(delivered)*
Full GenAI semantic conventions: `invoke_agent`, `chat {model}`, `execute_tool {name}`
spans with `gen_ai.*` attributes; `gen_ai.client.token.usage` and
`gen_ai.client.operation.duration` histograms; `gen_ai.client.inference.operation.details`
log event per chat step (message content opt-in via `captureContent`). `error.type`
on all error paths. Assert span tree + metrics + log events via `InMemoryExporter`.
The bespoke `fino:ai:event` topic has been removed — all telemetry is standard GenAI
semconv.

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

**Phase 9 — `fino:ai/sandbox`** *(deferred — see §5.7)*

**Phase 10 — `fino:ai/workflow`**
Graph builder over the session layer. Checkpoints every graph-node boundary via
the same `SqliteCheckpointStore`; graph state in `RunState.scratch`.

**Phase 11 — `fino:ai/skill`**
On-demand skill registry + `load_skill` tool. Skill tools execute in the
privileged environment (sandbox-gating deferred to a later milestone).

### Milestone D — Edges *(delivered)*

**Phase 12 — `fino:ai/channel` + `fino:ai/eval` + `fino:ai/mcp`** *(delivered)*
`agentDriver` + `httpChannel`/`webhookChannel`/`websocketChannel` headless
transport adapters with durable suspend/resume via `Session`; MCP client
transport/resource/tool adaptation. `evaluate()` with five scorers,
subclassable `EvalReporter` base, `OpenTelemetryReporter` emitting
standard `gen_ai.evaluation.result` events + `gen_ai.client.evaluation.score`
metric over OTLP (Braintrust and any collector via config). GenAI semconv
telemetry replaces all bespoke AI spans and `fino:ai:event` topic.

## 7. Verification (per phase)

```
cargo build               # ensures builtins register without error
cargo run -- test tests/ai                 # TAP, exit 0
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
