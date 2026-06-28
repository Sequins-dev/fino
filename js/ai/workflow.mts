/**
 * fino:ai/workflow — checkpointed multi-step workflows for agent applications.
 *
 * Workflows compose typed steps with sequential chaining, branches, parallel
 * fan-out, foreach loops, do-until loops, map transforms, and suspend/resume
 * gates. Use this module when an AI application needs deterministic control
 * flow around one or more agents or tools, especially when a run must survive
 * crashes or wait for human approval.
 *
 * ## Execution model
 *
 * A `Workflow` is an immutable builder. `commit()` produces a
 * `CompiledWorkflow`, and `createRun()` or `run()` executes it against a
 * `CheckpointStore`. Completed step outputs are recorded in `scratch`; resume
 * re-drives from the persisted cursor without re-running completed nodes.
 *
 * Workflow runs use only the run-checkpoint part of the session storage
 * contract. Steps may call `ctx.suspend()` to return a resume token. Suspension
 * inside parallel nodes is rejected because there is no single deterministic
 * continuation point.
 *
 * ```ts no_run
 * import { step, workflow, SqliteCheckpointStore } from 'fino:ai/workflow';
 *
 * const classify = step({
 *   id: 'classify',
 *   async execute(ctx) {
 *     return String(ctx.input).includes('refund') ? 'billing' : 'general';
 *   },
 * });
 *
 * const wf = workflow({ id: 'route-ticket' })
 *   .then(classify)
 *   .map((team) => ({ team }))
 *   .commit();
 *
 * const result = await wf.run('refund request', {
 *   store: await SqliteCheckpointStore.open('./workflow-runs.db'),
 * });
 * ```
 */

import { SqliteSessionStore as SqliteCheckpointStore } from 'fino:ai/session';
import { SuspendSignal, runContext } from 'fino:ai/runtime';
import { compile } from 'fino:validate';
import type { RunState, CheckpointStore } from 'fino:ai/session';

export type { CheckpointStore };
export { SqliteCheckpointStore };

let idCounter = 0;
function newId(): string {
  return `wf_${++idCounter}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Runtime context passed to a workflow step.
 */
export interface StepContext<In> {
  readonly input: In;
  readonly runId: string;
  readonly stepIndex: number;
  readonly signal: AbortSignal | undefined;
  readonly scratch: Record<string, unknown>;
  getStepResult(id: string): unknown;
  suspend(opts?: { reason?: string; payload?: unknown }): never;
}

/**
 * Definition used to create a workflow step.
 */
export interface StepDef<In, Out> {
  id: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  execute(ctx: StepContext<In>): Promise<Out>;
}

/**
 * A reusable workflow step.
 */
export class Step<In = unknown, Out = unknown> {
  readonly id: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly execute: (ctx: StepContext<In>) => Promise<Out>;

  constructor(def: StepDef<In, Out>) {
    this.id = def.id;
    this.inputSchema = def.inputSchema;
    this.outputSchema = def.outputSchema;
    this.execute = def.execute;
  }
}

/**
 * Create a workflow step.
 */
export function step<In = unknown, Out = unknown>(def: StepDef<In, Out>): Step<In, Out> {
  return new Step(def);
}

type Predicate<T> = (value: T) => boolean;

type GraphNode =
  | { type: 'step'; step: Step }
  | { type: 'branch'; arms: [Predicate<unknown>, Step][] }
  | { type: 'parallel'; steps: Step[] }
  | { type: 'foreach'; step: Step; concurrency?: number }
  | { type: 'doUntil'; step: Step; cond: Predicate<unknown> }
  | { type: 'map'; fn: (prev: unknown, ctx: StepContext<unknown>) => unknown };

/**
 * Immutable workflow builder.
 */
export class Workflow<In = unknown, Out = unknown> {
  #id: string;
  #inputSchema?: unknown;
  #outputSchema?: unknown;
  #nodes: GraphNode[];

  constructor(
    id: string,
    inputSchema?: unknown,
    outputSchema?: unknown,
    nodes: GraphNode[] = [],
  ) {
    this.#id = id;
    this.#inputSchema = inputSchema;
    this.#outputSchema = outputSchema;
    this.#nodes = nodes;
  }

  #clone(nodes: GraphNode[]): Workflow<In, Out> {
    return new Workflow(this.#id, this.#inputSchema, this.#outputSchema, nodes);
  }

  then<O>(s: Step<any, O>): Workflow<In, O> {
    return this.#clone([...this.#nodes, { type: 'step', step: s }]) as unknown as Workflow<In, O>;
  }

  branch(arms: [Predicate<any>, Step<any, any>][]): Workflow<In, unknown> {
    return this.#clone([...this.#nodes, { type: 'branch', arms }]);
  }

  parallel(steps: Step<any, any>[]): Workflow<In, unknown[]> {
    return this.#clone([...this.#nodes, { type: 'parallel', steps }]) as unknown as Workflow<In, unknown[]>;
  }

  foreach<I, O>(s: Step<I, O>, opts?: { concurrency?: number }): Workflow<In, O[]> {
    return this.#clone([...this.#nodes, { type: 'foreach', step: s, concurrency: opts?.concurrency }]) as unknown as Workflow<In, O[]>;
  }

  doUntil(s: Step<any, any>, cond: Predicate<any>): Workflow<In, unknown> {
    return this.#clone([...this.#nodes, { type: 'doUntil', step: s, cond }]);
  }

  map(fn: (prev: any, ctx: StepContext<any>) => any): Workflow<In, unknown> {
    return this.#clone([...this.#nodes, { type: 'map', fn }]);
  }

  commit(): CompiledWorkflow<In, Out> {
    return new CompiledWorkflow<In, Out>(
      this.#id,
      this.#inputSchema,
      this.#outputSchema,
      this.#nodes,
    );
  }
}

/**
 * Options for starting or resuming a workflow run.
 */
export interface WorkflowRunOptions {
  store: CheckpointStore;
  threadId?: string;
  onCheckpoint?: (s: RunState) => void;
}

/**
 * Result returned by workflow execution.
 */
export interface WorkflowResult {
  runId: string;
  status: RunState['status'];
  result?: unknown;
  state: RunState;
}

/**
 * Executable workflow graph.
 */
export class CompiledWorkflow<In = unknown, Out = unknown> {
  #id: string;
  #inputSchema?: unknown;
  #outputSchema?: unknown;
  #nodes: GraphNode[];

  constructor(
    id: string,
    inputSchema: unknown,
    outputSchema: unknown,
    nodes: GraphNode[],
  ) {
    this.#id = id;
    this.#inputSchema = inputSchema;
    this.#outputSchema = outputSchema;
    this.#nodes = nodes;
  }

  createRun(opts: WorkflowRunOptions): WorkflowRun<In, Out> {
    return new WorkflowRun<In, Out>(this.#nodes, this.#inputSchema, this.#outputSchema, opts);
  }

  async run(input: In, opts: WorkflowRunOptions): Promise<WorkflowResult> {
    return this.createRun(opts).start(input);
  }
}

/**
 * Stateful workflow run with start and resume support.
 */
export class WorkflowRun<In = unknown, Out = unknown> {
  #nodes: GraphNode[];
  #inputSchema?: unknown;
  #outputSchema?: unknown;
  #opts: WorkflowRunOptions;
  #threadId: string;
  #state: RunState | undefined;

  constructor(
    nodes: GraphNode[],
    inputSchema: unknown,
    outputSchema: unknown,
    opts: WorkflowRunOptions,
  ) {
    this.#nodes = nodes;
    this.#inputSchema = inputSchema;
    this.#outputSchema = outputSchema;
    this.#opts = opts;
    this.#threadId = opts.threadId ?? newId();
  }

  get state(): RunState | undefined {
    return this.#state;
  }

  async start(input: In, opts?: { runId?: string; signal?: AbortSignal }): Promise<WorkflowResult> {
    if (this.#inputSchema) {
      const v = compile(this.#inputSchema);
      const r = v.safeParse(input);
      if (!r.success) {
        throw new Error(`Workflow input validation failed: ${r.error.message}`);
      }
    }

    const runId = opts?.runId ?? newId();
    const signal = opts?.signal;

    const state: RunState = {
      runId,
      threadId: this.#threadId,
      status: 'running',
      stepIndex: 0,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      scratch: {
        workflowInput: input,
        stepResults: {},
        cursor: 0,
        completed: {},
        lastOutput: input,
      },
    };

    this.#state = state;
    await this.#opts.store.save(state);
    return this.#drive(state, signal);
  }

  static async resume<In, Out>(opts: WorkflowRunOptions & {
    workflow: CompiledWorkflow<In, Out>;
    runId: string;
  }): Promise<WorkflowResult> {
    const loaded = await opts.store.load(opts.runId);
    if (!loaded) throw new Error(`Workflow run ${opts.runId} not found`);
    if (loaded.status === 'done' || loaded.status === 'cancelled') {
      return { runId: loaded.runId, status: loaded.status, result: loaded.result, state: loaded };
    }
    if (loaded.status === 'suspended') {
      throw new Error(`Run ${opts.runId} is suspended; use instance resume(token, value) instead`);
    }
    const run = opts.workflow.createRun(opts);
    run.#threadId = loaded.threadId;
    run.#state = loaded;
    return run.#drive({ ...loaded, status: 'running' });
  }

  async resume(resumeToken: string, value: unknown, opts?: { signal?: AbortSignal }): Promise<WorkflowResult> {
    if (!this.#state) throw new Error('No state; call start() first');
    if (this.#state.status !== 'suspended') {
      throw new Error(`Run is not suspended (currently: ${this.#state.status})`);
    }
    if (this.#state.suspendedOn?.token !== resumeToken) {
      throw new Error('Invalid or expired resume token');
    }

    const state: RunState = {
      ...this.#state,
      status: 'running',
      suspendedOn: undefined,
      scratch: {
        ...this.#state.scratch,
        resumeValue: value,
      },
    };
    return this.#drive(state, opts?.signal);
  }

  async cancel(): Promise<void> {
    if (!this.#state) return;
    const state: RunState = { ...this.#state, status: 'cancelled' };
    this.#state = state;
    await this.#opts.store.save(state);
  }

  async #drive(state: RunState, signal?: AbortSignal): Promise<WorkflowResult> {
    const runCtxValue = { runId: state.runId, stepIndex: state.stepIndex, signal };
    return runContext.runWithValue(runCtxValue, async () => {
      const scratch = state.scratch as {
        workflowInput: unknown;
        stepResults: Record<string, unknown>;
        cursor: number;
        completed: Record<string, boolean[]>;
        resumeValue?: unknown;
        lastOutput?: unknown;
      };

      let cursor = scratch.cursor as number;
      let lastOutput: unknown = scratch.lastOutput;

      while (cursor < this.#nodes.length) {
        runCtxValue.stepIndex = state.stepIndex;

        const node = this.#nodes[cursor]!;

        const makeCtx = (input: unknown, ctxOpts: { allowSuspend?: boolean; owner?: string } = {}): StepContext<unknown> => ({
          input,
          runId: state.runId,
          stepIndex: state.stepIndex,
          signal,
          scratch: state.scratch,
          getStepResult: (id: string) => (state.scratch['stepResults'] as Record<string, unknown>)[id],
          suspend(suspendOpts?: { reason?: string; payload?: unknown }): never {
            if (!ctxOpts.allowSuspend) {
              const owner = ctxOpts.owner ?? 'composite workflow node';
              throw new Error(`${owner} cannot suspend; use an explicit approval step outside composite nodes`);
            }
            throw new SuspendSignal(suspendOpts?.reason, suspendOpts?.payload);
          },
        });

        try {
          let output: unknown;

          if (node.type === 'step') {
            const ctx = makeCtx(lastOutput ?? scratch.workflowInput, { allowSuspend: true });
            output = await node.step.execute(ctx);
            if (node.step.outputSchema) {
              const v = compile(node.step.outputSchema);
              const r = v.safeParse(output);
              if (!r.success) {
                throw new Error(`Step "${node.step.id}" output validation failed: ${r.error.message}`);
              }
            }
            (scratch.stepResults as Record<string, unknown>)[node.step.id] = output;

          } else if (node.type === 'branch') {
            let matched = false;
            for (const [pred, s] of node.arms) {
              if (pred(lastOutput)) {
                const ctx = makeCtx(lastOutput, { allowSuspend: true });
                output = await s.execute(ctx);
                (scratch.stepResults as Record<string, unknown>)[s.id] = output;
                matched = true;
                break;
              }
            }
            if (!matched) {
              output = lastOutput;
            }

          } else if (node.type === 'parallel') {
            const completedBits = (scratch.completed[`p_${cursor}`] as boolean[] | undefined) ?? [];
            const inputs = Array.isArray(lastOutput) ? lastOutput : node.steps.map(() => lastOutput);
            const results: unknown[] = [];
            for (let i = 0; i < node.steps.length; i++) {
              if (completedBits[i]) {
                results.push((scratch.stepResults as Record<string, unknown>)[node.steps[i]!.id]);
              } else {
                results.push(undefined);
              }
            }

            await Promise.all(
              node.steps.map(async (s, i) => {
                if (completedBits[i]) return;
                const ctx = makeCtx(inputs[i], { owner: 'parallel workflow node' });
                const r = await s.execute(ctx);
                (scratch.stepResults as Record<string, unknown>)[s.id] = r;
                results[i] = r;
                completedBits[i] = true;
              }),
            );

            scratch.completed[`p_${cursor}`] = completedBits;
            output = results;

          } else if (node.type === 'foreach') {
            const items = Array.isArray(lastOutput) ? lastOutput : [lastOutput];
            const concurrency = node.concurrency ?? items.length;
            const results: unknown[] = new Array(items.length);
            const completedBits = (scratch.completed[`fe_${cursor}`] as boolean[] | undefined) ?? [];

            let idx = 0;
            while (idx < items.length) {
              const batch = [];
              for (let b = 0; b < concurrency && idx < items.length; b++, idx++) {
                const i = idx;
                if (completedBits[i]) {
                  results[i] = (scratch.stepResults as Record<string, unknown>)[`${node.step.id}[${i}]`];
                  continue;
                }
                batch.push((async () => {
                  const ctx = makeCtx(items[i], { owner: 'foreach workflow node' });
                  const r = await node.step.execute(ctx);
                  (scratch.stepResults as Record<string, unknown>)[`${node.step.id}[${i}]`] = r;
                  results[i] = r;
                  completedBits[i] = true;
                })());
              }
              await Promise.all(batch);
            }

            scratch.completed[`fe_${cursor}`] = completedBits;
            output = results;

          } else if (node.type === 'doUntil') {
            let loopOut = lastOutput;
            do {
              const ctx = makeCtx(loopOut, { owner: 'doUntil workflow node' });
              loopOut = await node.step.execute(ctx);
              (scratch.stepResults as Record<string, unknown>)[node.step.id] = loopOut;
            } while (!node.cond(loopOut));
            output = loopOut;

          } else if (node.type === 'map') {
            const ctx = makeCtx(lastOutput, { allowSuspend: true });
            output = node.fn(lastOutput, ctx);
          }

          lastOutput = output;
          cursor++;
          state = {
            ...state,
            stepIndex: state.stepIndex + 1,
            scratch: { ...scratch, cursor, lastOutput },
          };
          this.#state = state;
          await this.#opts.store.save(state);
          this.#opts.onCheckpoint?.(state);

        } catch (err) {
          const e = err as Error;

          if (e.name === 'SuspendSignal') {
            const sig = e as SuspendSignal;
            const token = newId();
            state = {
              ...state,
              status: 'suspended',
              suspendedOn: {
                token,
                reason: sig.message,
                payload: sig.payload,
              },
              scratch: { ...scratch, cursor: cursor + 1, lastOutput },
            };
            this.#state = state;
            await this.#opts.store.save(state);
            return { runId: state.runId, status: 'suspended', state };
          }

          if (e.name === 'AbortError') {
            state = { ...state, status: 'cancelled', scratch: { ...scratch, cursor, lastOutput } };
            this.#state = state;
            await this.#opts.store.save(state);
            throw err;
          }

          state = {
            ...state,
            status: 'error',
            error: { message: e.message, stack: e.stack },
            scratch: { ...scratch, cursor, lastOutput },
          };
          this.#state = state;
          await this.#opts.store.save(state);
          throw err;
        }
      }

      if (this.#outputSchema) {
        const v = compile(this.#outputSchema);
        const r = v.safeParse(lastOutput);
        if (!r.success) {
          state = {
            ...state,
            status: 'error',
            error: { message: `Workflow output validation failed: ${r.error.message}` },
          };
          this.#state = state;
          await this.#opts.store.save(state);
          throw new Error(state.error!.message);
        }
      }

      state = { ...state, status: 'done', result: lastOutput };
      this.#state = state;
      await this.#opts.store.save(state);
      return { runId: state.runId, status: 'done', result: lastOutput, state };
    });
  }
}

/**
 * Create a workflow builder.
 */
export function workflow<In = unknown, Out = unknown>(def: {
  id: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}): Workflow<In, Out> {
  return new Workflow<In, Out>(def.id, def.inputSchema, def.outputSchema);
}
