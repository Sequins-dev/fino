/**
* Zero-build server-driven agent chat.
*
* Run:
*
*   OPENAI_API_KEY=... \
*   SESSION_SECRET=... \
*   UI_CSRF_SECRET=... \
*   ./target/debug/fino demos/web-agent-chat.ts
*
* Then open http://127.0.0.1:3000. Model deltas update a signal and each
* awaited checkpoint is persisted to SQLite and broadcast as an SSE patch.
* A second tab receives the same patches when it displays the same view URL.
*/
import { openai } from 'fino:ai/model';
import { env } from 'fino:process';
import { DatabaseViewStore } from 'fino:ui/web/state';
import { createWebAgentChatApp } from './web-agent-chat-app';
const apiKey = env.OPENAI_API_KEY;
const sessionSecret = env.SESSION_SECRET;
const csrfSecret = env.UI_CSRF_SECRET;
if (!apiKey || !sessionSecret || !csrfSecret) {
  throw new Error('OPENAI_API_KEY, SESSION_SECRET, and UI_CSRF_SECRET are required');
}
const store = await DatabaseViewStore.open('sqlite://web-agent-chat.db');
const app = createWebAgentChatApp({
  model: openai({
    apiKey,
    model: env.OPENAI_MODEL ?? 'gpt-4o-mini'
  }),
  store,
  sessionSecret,
  csrfSecret
});
app.listen({ port: Number(env.PORT ?? 3e3) });
