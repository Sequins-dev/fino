/**
 * fino:ui/web/flow — workflow-backed server-driven pages.
 *
 * `flowPage()` connects bounded multi-step workflows to the portable UI engine.
 * A GET without `?run=` starts the workflow and redirects to a URL containing
 * the run id. Later GETs render the persisted `WorkflowState` as HTML or as a
 * semantic JSON stream, and the signal the workflow is waiting on is delivered
 * through an ordinary view action, so it inherits session ownership, origin and
 * CSRF checks, replay protection, input validation, and the shared safe error
 * envelope rather than reimplementing them.
 *
 * The workflow store stays the only durable copy of run state. The view snapshot
 * holds just the run id and the step the rendered form was addressed to; the run
 * itself is a derived signal, reloaded from the store for every render.
 *
 * `webUI()` must be installed, because the action and live-stream paths belong
 * to it. Only a GET route is needed — the action posts back to the same path and
 * is handled by the middleware.
 *
 * ```ts no_run
 * import { flowPage } from 'fino:ui/web/flow';
 * import { webUI } from 'fino:ui/web';
 * import { h } from 'fino:ui';
 *
 * const ui = app.layer(webUI({ store: views, secret: 'dev-secret' }));
 * ui.get('/checkout').handle(
 *   flowPage(checkout, {
 *     store,
 *     start: () => ({ cart: [] }),
 *     render: (ctx, state, advance) =>
 *       h('form', { action: advance }, h('button', null, state.waitingOn?.name ?? 'done')),
 *   }),
 * );
 * ```
 */
import { h, Signal, type VNode } from 'fino:ui';
import { page, view, ViewActionError } from 'fino:ui/web';
import type { Handler, HttpContext } from 'fino:net/http/app';
import type { JsonSchema } from 'fino:validate';
import type { Workflow, WorkflowState, WorkflowStore } from 'fino:workflow';

/** Durable-state key recording which session owns a run. */
const OWNER_KEY = 'fino:ui/flow:owner';

/**
 * Action descriptor passed to a flow page's render function.
 *
 * Use it as a form's `action` prop so the submit is wired to the flow action.
 */
export type FlowAdvance = unknown;

export interface FlowPageOptions<In = unknown> {
  /** Durable workflow store containing runs for this page. */
  store: WorkflowStore;
  /** Input factory used when a GET starts a new run. */
  start: (ctx: HttpContext) => In | Promise<In>;
  /**
   * Render the current workflow state.
   *
   * `advance` is the action descriptor for delivering the awaited signal; give it
   * to a form's `action` prop. The signal payload is read from the form field
   * named after the awaited signal.
   */
  render: (ctx: HttpContext, state: WorkflowState, advance: FlowAdvance) => VNode;
  /** Optional schema validating the submitted signal payload object. */
  input?: JsonSchema;
  /**
   * View definition id. Defaults to `fino:flow/<workflow id>`.
   *
   * Set this when one workflow backs more than one page, so each page gets its
   * own view definition.
   */
  id?: string;
}

function runUrl(ctx: HttpContext, runId: string): string {
  const url = new URL(ctx.request.url);
  url.searchParams.delete('_action');
  url.searchParams.set('run', runId);
  return `${url.pathname}${url.search}`;
}

function sessionOf(ctx: HttpContext): string | undefined {
  const session = ctx.session as { id?: unknown } | undefined;
  return typeof session?.id === 'string' ? session.id : undefined;
}

function ownerOf(state: WorkflowState): string | undefined {
  const owner = state.state[OWNER_KEY];
  return typeof owner === 'string' ? owner : undefined;
}

/**
 * A run with no recorded owner is open, which keeps runs started before a session
 * existed reachable. Once an owner is recorded, only that session may act.
 */
function ownedBy(state: WorkflowState, session: string | undefined): boolean {
  const owner = ownerOf(state);
  return owner === undefined || owner === session;
}

function coerce(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  const numeric = Number(value);
  if (value.trim() !== '' && Number.isFinite(numeric) && String(numeric) === value) return numeric;
  return value;
}

// WorkflowStore.save() has no compare-and-swap, so serialize per run. Two tabs
// hold different view snapshots and would otherwise both pass their own revision
// check and interleave a signal with a resume.
const runLocks = new Map<string, Promise<void>>();
async function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const previous = runLocks.get(runId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  runLocks.set(
    runId,
    previous.then(() => current),
  );
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (runLocks.get(runId) === current) runLocks.delete(runId);
  }
}

// The view render function is synchronous and receives no HttpContext, so the
// active request is tracked here for the duration of one render, the same way
// web.ts tracks its current render environment.
let currentHttp: HttpContext | null = null;

const flowViews = new Map<string, ReturnType<typeof view>>();

function awaitedSignal(state: WorkflowState | null): { step: number; name: string } | null {
  if (state === null || state.status !== 'waiting' || state.waitingOn?.type !== 'signal')
    return null;
  return { step: state.waitingOn.stepIndex, name: state.waitingOn.name };
}

/**
 * Create a route handler for a bounded workflow-backed page.
 */
export function flowPage<In, Out>(workflow: Workflow<In, Out>, opts: FlowPageOptions<In>): Handler {
  const viewId = opts.id ?? `fino:flow/${workflow.id}`;
  if (!flowViews.has(viewId)) {
    flowViews.set(
      viewId,
      view({
        id: viewId,
        derived: ['run'],
        state: () => ({
          runId: new Signal(''),
          awaitedStep: new Signal<number | null>(null),
          awaitedName: new Signal<string | null>(null),
          run: new Signal<WorkflowState | null>(null),
        }),
        async derive({ state }) {
          const runId = state.runId.get() as string;
          state.run.set(runId === '' ? null : await opts.store.load(runId));
        },
        actions: {
          advance: {
            input: opts.input,
            async handler({ state, http }, input) {
              const runId = state.runId.get() as string;
              const expected = {
                step: state.awaitedStep.get() as number | null,
                name: state.awaitedName.get() as string | null,
              };
              await withRunLock(runId, async () => {
                const current = await opts.store.load(runId);
                if (current === null)
                  throw new ViewActionError('view_expired', {
                    status: 410,
                    recoverable: false,
                  });
                if (current.workflowId !== workflow.id)
                  throw new ViewActionError('action_not_found', {
                    status: 404,
                    recoverable: false,
                  });
                if (!ownedBy(current, sessionOf(http)))
                  throw new ViewActionError('forbidden', { status: 403, recoverable: false });
                const wait = awaitedSignal(current);
                if (wait === null)
                  throw new ViewActionError('flow_not_waiting', {
                    status: 409,
                    recoverable: true,
                  });
                // The run can advance without this view's revision changing —
                // another tab, or a timer. Bind the submit to the exact step it
                // was rendered for so an old form cannot advance a newer wait.
                if (wait.step !== expected.step || wait.name !== expected.name)
                  throw new ViewActionError('flow_stale_step', {
                    status: 409,
                    recoverable: true,
                  });
                await workflow.signal({
                  store: opts.store,
                  runId,
                  name: wait.name,
                  payload: coerce((input as Record<string, unknown>)[wait.name]),
                });
                await workflow.resume({ store: opts.store, runId });
                const next = await opts.store.load(runId);
                const nextWait = awaitedSignal(next);
                state.run.set(next);
                state.awaitedStep.set(nextWait?.step ?? null);
                state.awaitedName.set(nextWait?.name ?? null);
              });
            },
          },
        },
        render({ state, actions }) {
          const run = state.run.get() as WorkflowState | null;
          const ctx = currentHttp;
          if (run === null || ctx === null)
            return h('p', { 'data-fi-flow': 'missing' }, 'Workflow run not found');
          return opts.render(ctx, run, actions.advance);
        },
      }),
    );
  }
  const flowView = flowViews.get(viewId)!;
  return async (ctx) => {
    if (ctx.request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
    const url = new URL(ctx.request.url);
    const runId = url.searchParams.get('run');
    if (runId === null) {
      const started = await workflow.start(await opts.start(ctx), { store: opts.store });
      const session = sessionOf(ctx);
      if (session !== undefined) {
        const persisted = await opts.store.load(started.runId);
        if (persisted !== null) {
          persisted.state[OWNER_KEY] = session;
          await opts.store.save(persisted);
        }
      }
      return new Response(null, { status: 303, headers: { location: runUrl(ctx, started.runId) } });
    }
    const state = await opts.store.load(runId);
    if (state === null || state.workflowId !== workflow.id)
      return new Response('Workflow run not found', { status: 404 });
    if (!ownedBy(state, sessionOf(ctx))) return new Response('Forbidden', { status: 403 });
    const wait = awaitedSignal(state);
    currentHttp = ctx;
    try {
      return await page((inner) => {
        const tree = flowView.mount(inner, {
          runId,
          awaitedStep: wait?.step ?? null,
          awaitedName: wait?.name ?? null,
          run: state,
        });
        return tree;
      })(ctx);
    } finally {
      currentHttp = null;
    }
  };
}

export { observableWorkflowStore, watchRun } from 'fino:workflow';
