import { describe, it } from 'fino:test/test';
import type { GenerateRequest, Model, ModelStream, StreamEvent } from 'fino:ai/model';
import { ModelStreamImpl } from 'internal:ai/shared';
import { createWebAgentChatApp } from '../demos/web-agent-chat-app';
import { InMemoryViewStore } from 'fino:ui/web/state';
function hidden(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`name="${escaped}" value="([^"]*)"`));
  if (!match) throw new Error(`missing hidden input ${name}`);
  return match[1]!;
}
function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
function streamingModel(): Model {
  return {
    name: 'demo-test',
    dimensions: 0,
    stream(_request: GenerateRequest): ModelStream {
      async function* events(): AsyncGenerator<StreamEvent> {
        yield {
          type: 'text_delta',
          index: 0,
          text: 'Hello',
        };
        yield {
          type: 'text_delta',
          index: 0,
          text: ' world',
        };
        yield {
          type: 'usage',
          usage: {
            inputTokens: 1,
            outputTokens: 2,
          },
        };
        yield {
          type: 'stop',
          reason: 'end_turn',
        };
      }
      return new ModelStreamImpl(events());
    },
    async generate() {
      throw new Error('demo uses streaming');
    },
    async embed() {
      return [];
    },
  };
}
describe('zero-build web agent chat demo', () => {
  it('streams checkpoints to the action and a second live tab, then persists them', async (t) => {
    const store = new InMemoryViewStore();
    const app = createWebAgentChatApp({
      model: streamingModel(),
      store,
      sessionSecret: 'demo-session-secret',
      csrfSecret: 'demo-csrf-secret',
    });
    const first = (await app.handle(new Request('http://local/'))) as Response;
    const html = await first.text();
    const cookie = cookieHeader(first);
    const viewId = hidden(html, '_view');
    const live = (await app.handle(
      new Request(`http://local/_fino/live?view=${viewId}`, {
        headers: {
          accept: 'text/event-stream',
          cookie,
        },
      }),
    )) as Response;
    const liveReader = live.body!.getReader();
    await liveReader.read();
    const body = new URLSearchParams({
      _view: viewId,
      _ver: hidden(html, '_ver'),
      _nonce: hidden(html, '_nonce'),
      _csrf: hidden(html, '_csrf'),
      $draft: '',
      prompt: 'Say hello',
    });
    const action = (await app.handle(
      new Request('http://local/?_action=agent-chat.send', {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://local',
          'sec-fetch-site': 'same-origin',
        },
        body: body.toString(),
      }),
    )) as Response;
    const actionText = await action.text();
    t.ok(
      actionText.includes('Hello world'),
      'enhanced action receives the completed streamed response',
    );
    const liveUpdate = await liveReader.read();
    t.ok(
      new TextDecoder().decode(liveUpdate.value).includes('event: patch'),
      'second tab receives a live patch',
    );
    await liveReader.cancel();
    const snapshot = await store.load(viewId);
    t.ok((snapshot?.version ?? 0) >= 4, 'initial, delta, and final checkpoints are durable');
    t.deepEqual(snapshot?.data.messages, [
      {
        role: 'user',
        text: 'Say hello',
      },
      {
        role: 'assistant',
        text: 'Hello world',
      },
    ]);
  });
});
