import { describe, it } from 'fino:test/test';
import { App } from 'fino:net/http/app';
import { h } from 'fino:ui';
import { flowPage } from 'fino:ui/web/flow';
import { InMemoryWorkflowStore, workflow } from 'fino:workflow';

const approval = workflow({
  id: 'approval-flow',
  async run(ctx, input: { label: string }) {
    const approved = await ctx.waitForSignal<boolean>('approval');
    return { label: input.label, approved };
  },
});

describe('fino:ui/web/flow', () => {
  it('starts, renders, signals, resumes, and redirects a workflow-backed page', async (t) => {
    const store = new InMemoryWorkflowStore();
    const app = new App();
    app.get('/flow').handle(
      flowPage(approval, {
        store,
        start: () => ({ label: 'deploy' }),
        render(_ctx, state) {
          if (state.status === 'done')
            return h('p', { id: 'done' }, String((state.result as { approved: boolean }).approved));
          return h(
            'form',
            { method: 'post' },
            h('input', { type: 'hidden', name: 'approval', value: 'true' }),
            h('button', null, state.waitingOn?.name ?? 'waiting'),
          );
        },
      }),
    );
    app.post('/flow').handle(
      flowPage(approval, {
        store,
        start: () => ({ label: 'deploy' }),
        render: (_ctx, state) => h('p', null, state.status),
      }),
    );

    const start = (await app.handle(new Request('http://local/flow'))) as Response;
    t.equal(start.status, 303, 'initial GET redirects to a run URL');
    const location = start.headers.get('location')!;
    t.ok(location.includes('run='), 'redirect includes run id');

    const waiting = (await app.handle(new Request(`http://local${location}`))) as Response;
    const waitingHtml = await waiting.text();
    t.ok(waitingHtml.includes('approval'), 'waiting step renders');

    const signaled = (await app.handle(
      new Request(`http://local${location}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ approval: 'true' }).toString(),
      }),
    )) as Response;
    t.equal(signaled.status, 303, 'signal POST redirects back to run URL');

    const done = (await app.handle(new Request(`http://local${location}`))) as Response;
    t.ok((await done.text()).includes('<p id="done">true</p>'), 'completed result renders');
  });
});
