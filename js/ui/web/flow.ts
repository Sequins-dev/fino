/**
* fino:ui/web/flow — workflow-backed server-rendered pages.
*
* `flowPage()` connects bounded multi-step workflows to ordinary HTTP pages.
* A GET without `?run=` starts the workflow and redirects to a URL containing
* the run id. Later GETs render the persisted `WorkflowState`; POSTs deliver
* the signal the workflow is currently waiting on, resume the run, and redirect
* back to the same run URL.
*
* ```ts no_run
* import { flowPage } from 'fino:ui/web/flow';
* import { SqliteWorkflowStore } from 'fino:workflow';
*
* app.get('/checkout').handle(flowPage(checkout, { store, start, render }));
* app.post('/checkout').handle(flowPage(checkout, { store, start, render }));
* ```
*/
import type { Handler, HttpContext } from 'fino:net/http/app';
import { renderToHtml } from 'fino:ui/html';
import type { VNode } from 'fino:ui';
import type { Workflow, WorkflowState, WorkflowStore } from 'fino:workflow';

export interface FlowPageOptions<In = unknown> {
  /** Durable workflow store containing runs for this page. */
  store: WorkflowStore;
  /** Input factory used when a GET starts a new run. */
  start: (ctx: HttpContext) => In | Promise<In>;
  /** Render the current workflow state as a Fino UI tree. */
  render: (ctx: HttpContext, state: WorkflowState) => VNode;
}

function runUrl(ctx: HttpContext, runId: string): string {
  const url = new URL(ctx.request.url);
  url.searchParams.set('run', runId);
  return `${url.pathname}${url.search}`;
}

function redirect(url: string): Response {
  return new Response(null, { status: 303, headers: { location: url } });
}

function parsePayload(value: FormDataEntryValue | null): unknown {
  if (value === null) return undefined;
  const text = typeof value === 'string' ? value : value.name;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  const numeric = Number(text);
  if (text.trim() !== '' && Number.isFinite(numeric) && String(numeric) === text) return numeric;
  return text;
}

async function renderState(ctx: HttpContext, opts: FlowPageOptions, runId: string): Promise<Response> {
  const state = await opts.store.load(runId);
  if (state === null) return new Response('Workflow run not found', { status: 404 });
  return new Response('<!doctype html>' + renderToHtml(opts.render(ctx, state)), {
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
}

/**
* Create a route handler for a bounded workflow-backed page.
*/
export function flowPage<In, Out>(workflow: Workflow<In, Out>, opts: FlowPageOptions<In>): Handler {
  return async (ctx) => {
    const url = new URL(ctx.request.url);
    const runId = url.searchParams.get('run');
    if (ctx.request.method === 'GET') {
      if (runId === null) {
        const started = await workflow.start(await opts.start(ctx), { store: opts.store });
        return redirect(runUrl(ctx, started.runId));
      }
      return renderState(ctx, opts, runId);
    }
    if (ctx.request.method === 'POST') {
      if (runId === null) return new Response('Missing workflow run', { status: 400 });
      const state = await opts.store.load(runId);
      if (state === null) return new Response('Workflow run not found', { status: 404 });
      if (state.waitingOn?.type !== 'signal') return redirect(runUrl(ctx, runId));
      const form = await ctx.request.formData();
      await workflow.signal({
        store: opts.store,
        runId,
        name: state.waitingOn.name,
        payload: parsePayload(form.get(state.waitingOn.name))
      });
      await workflow.resume({ store: opts.store, runId });
      return redirect(runUrl(ctx, runId));
    }
    return new Response('Method Not Allowed', { status: 405 });
  };
}

export { observableWorkflowStore, watchRun } from 'fino:workflow';
