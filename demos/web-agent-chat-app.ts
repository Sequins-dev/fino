/**
* Reusable application factory for the zero-build web agent chat demo.
*/
import { agent } from 'fino:ai/agent';
import type { Model } from 'fino:ai/model';
import { memoryCache } from 'fino:cache';
import type { RevisionedCache } from 'fino:cache';
import { App, cookies, sessions } from 'fino:net/http/app';
import { h, Signal } from 'fino:ui';
import { clientScriptPath, page, view, webUI } from 'fino:ui/web';
import type { ViewStateStore } from 'fino:ui/web/state';

interface Message {
  role: 'user' | 'assistant';
  text: string;
}

export interface WebAgentChatOptions {
  /** Parent-owned model used for streamed agent responses. */
  model: Model;
  /** Durable view state store. */
  store: ViewStateStore;
  /** Cookie-sealing key for HTTP sessions. */
  sessionSecret: string;
  /** Independent key for view action CSRF tokens. */
  csrfSecret: string;
  /** Optional caller-owned session store. */
  sessionStore?: RevisionedCache;
}

/**
* Build the production-shaped demo without starting a listener.
*
* Keeping construction separate from `listen()` lets the acceptance test drive
* the exact application through `App.handle()`.
*/
export function createWebAgentChatApp(options: WebAgentChatOptions): App {
  const bot = agent({
    model: options.model,
    instructions: 'Answer clearly and concisely.',
  });
  const chat = view({
    id: 'agent-chat',
    state: () => ({
      messages: new Signal<Message[]>([]),
      draft: new Signal(''),
      running: new Signal(false),
    }),
    embed: ['draft'],
    actions: {
      send: {
        async handler({ state, checkpoint }, input) {
          const prompt = String(input.prompt ?? '').trim();
          if (!prompt || state.running.get()) return;
          const messages = state.messages.get().concat(
            { role: 'user' as const, text: prompt },
            { role: 'assistant' as const, text: '' },
          );
          state.messages.set(messages);
          state.draft.set('');
          state.running.set(true);
          await checkpoint();

          const prior = messages.slice(0, -1).map((message) => ({
            role: message.role,
            content: message.text,
          }));
          const stream = bot.stream({ messages: prior });
          for await (const event of stream.reader) {
            if (event.type !== 'model_event' || event.event.type !== 'text_delta') continue;
            state.messages.set((current) => {
              const next = current.slice();
              const last = next.at(-1)!;
              next[next.length - 1] = { ...last, text: last.text + event.event.text };
              return next;
            });
            await checkpoint();
          }
          await stream.result;
          state.running.set(false);
        },
      },
    },
    render({ state, actions }) {
      return h('main', null,
        h('h1', null, 'Fino agent chat'),
        h('ol', null, state.messages.get().map((message) =>
          h('li', { class: message.role }, `${message.role}: ${message.text}`)
        )),
        h('form', { action: actions.send },
          h('input', {
            name: 'prompt',
            value: state.draft.get(),
            autocomplete: 'off',
            disabled: state.running.get(),
          }),
          h('button', { disabled: state.running.get() }, state.running.get() ? 'Thinking…' : 'Send'),
        ),
      );
    },
  });

  const app = new App();
  const routes = app
    .value('cookies', cookies())
    .value('session', sessions({
      store: options.sessionStore ?? memoryCache({ namespace: 'web-agent-chat-sessions' }),
      keys: [{ id: 'current', secret: options.sessionSecret }],
      ttlMs: 24 * 60 * 60 * 1000,
    }))
    .layer(webUI({
      store: options.store,
      secret: options.csrfSecret,
      ttlMs: 24 * 60 * 60 * 1000,
    }));

  routes.get('/').handle(page((ctx) =>
    h('html', null,
      h('head', null, h('title', null, 'Fino agent chat')),
      h('body', null, chat.mount(ctx), h('script', { src: clientScriptPath(), defer: true })),
    )
  ));
  return app;
}
