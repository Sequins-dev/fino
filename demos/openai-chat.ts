/**
* Basic OpenAI-backed TUI chat demo.
*
* Run with:
*
*   ./target/debug/fino demos/openai-chat.ts
*
* Optional:
*
*   OPENAI_MODEL=local-model ./target/debug/fino demos/openai-chat.ts
*/
import { agent, streamText } from 'fino:ai/agent';
import { openai } from 'fino:ai/model';
import { env } from 'fino:process';
import { h } from 'fino:ui';
import { Box, Input, Scroll, Text, measureTerminalSize, render, type TuiApp, type TuiEvent } from 'fino:tty/tui';
const apiKey = env.OPENAI_API_KEY ?? 'local';
const baseUrl = env.OPENAI_BASE_URL ?? 'http://127.0.0.1:8080/v1';
const modelName = env.OPENAI_MODEL ?? 'qwen3.6-40b-claude-4.6-opus-deckard-heretic-uncensored-thinking-8bit';
interface ChatMessage {
  role: 'you' | 'ai' | 'system';
  text: string;
}
interface TranscriptRow {
  text: string;
  messageIndex: number | null;
}
const messages: ChatMessage[] = [{
  role: 'system',
  text: 'Commands: /exit, /quit, /clear. Enter sends. Ctrl-C exits. Mouse wheel scrolls.'
}];
const terminal = await measureTerminalSize();
const width = terminal.width;
const height = terminal.height;
const contentWidth = Math.max(1, width);
const inputBandHeight = 3;
const statusHeight = 1;
const transcriptHeight = Math.max(1, height - inputBandHeight - statusHeight);
let bot = createBot();
let app: TuiApp;
let input = '';
let status = 'Ready';
let scrollOffset = 0;
let selectedMessageIndex: number | null = null;
let streaming = false;
let finish: (() => void) | null = null;
const finished = new Promise<void>((resolve) => {
  finish = resolve;
});
function createBot() {
  return agent({
    name: 'openai-cli-chat',
    model: openai({
      apiKey,
      baseUrl,
      model: modelName,
      temperature: .4,
      maxTokens: 800
    }),
    instructions: ['You are a concise CLI assistant.', 'Answer plainly and ask one clarifying question when the request is ambiguous.'].join(' ')
  });
}
function prefixFor(role: ChatMessage['role']): string {
  if (role === 'you') return 'you: ';
  if (role === 'ai') return 'ai:  ';
  return '*   ';
}
function wrapLine(text: string, limit: number): string[] {
  if (limit <= 0) return [''];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (word.length === 0) continue;
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= limit) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
    while (current.length > limit) {
      lines.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current.length > 0 || lines.length === 0) lines.push(current);
  return lines;
}
function transcriptRows(): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]!;
    const prefix = prefixFor(message.role);
    const markerWidth = 2;
    const wrapped = wrapLine(message.text, Math.max(1, contentWidth - markerWidth - prefix.length));
    const marker = selectedMessageIndex === messageIndex ? '| ' : '  ';
    rows.push({
      text: marker + prefix + wrapped[0],
      messageIndex
    });
    for (let i = 1; i < wrapped.length; i++) {
      rows.push({
        text: marker + ' '.repeat(prefix.length) + wrapped[i],
        messageIndex
      });
    }
    rows.push({
      text: '',
      messageIndex: null
    });
  }
  if (rows.length > 0) rows.pop();
  return rows;
}
function maxScroll(): number {
  return Math.max(0, transcriptRows().length - transcriptHeight);
}
function clampScroll(): void {
  scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll()));
}
function scrollToBottom(): void {
  scrollOffset = maxScroll();
}
function view() {
  clampScroll();
  const rows = transcriptRows();
  return h(Box, {
    direction: 'column',
    gap: 0
  }, h(Scroll, {
    height: transcriptHeight,
    offset: scrollOffset
  }, ...rows.map((row) => h(Text, null, row.text))), h(Box, {
    height: inputBandHeight,
    paddingY: 1,
    background: 'black'
  }, h(Input, {
    value: input.length > 0 ? input : 'type here',
    focused: true,
    background: 'black'
  })), h(Text, { background: 'blue' }, `${modelName} - ${status}`));
}
function redraw(): void {
  app.update(view());
}
function exit(): void {
  app.stop();
  finish?.();
}
async function sendMessage(message: string): Promise<void> {
  messages.push({
    role: 'you',
    text: message
  });
  messages.push({
    role: 'ai',
    text: ''
  });
  input = '';
  status = 'Streaming response...';
  streaming = true;
  scrollToBottom();
  redraw();
  try {
    const stream = bot.stream(message);
    for await (const text of streamText(stream)) {
      messages[messages.length - 1]!.text += text;
      scrollToBottom();
      redraw();
    }
    await stream.result;
    status = 'Ready';
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    messages[messages.length - 1]!.text = `request failed: ${detail}`;
    status = 'Request failed.';
  } finally {
    streaming = false;
    scrollToBottom();
    redraw();
  }
}
async function handleEvent(event: TuiEvent): Promise<void> {
  if (event.type === 'mouse') {
    if (event.action === 'press' && event.button === 'left' && event.y < transcriptHeight) {
      const row = transcriptRows()[scrollOffset + event.y];
      selectedMessageIndex = row?.messageIndex ?? null;
      redraw();
      return;
    }
    if (event.action === 'wheel' && event.button === 'wheel-up') scrollOffset -= 3;
    if (event.action === 'wheel' && event.button === 'wheel-down') scrollOffset += 3;
    redraw();
    return;
  }
  if (event.ctrl && event.key === 'c') {
    exit();
    return;
  }
  if (event.key === 'backspace') {
    input = input.slice(0, -1);
    redraw();
    return;
  }
  if (event.key === 'enter') {
    const message = input.trim();
    if (message.length === 0) return;
    if (streaming) {
      status = 'Still streaming previous response.';
      redraw();
      return;
    }
    if (message === '/exit' || message === '/quit') {
      exit();
      return;
    }
    if (message === '/clear') {
      bot = createBot();
      messages.splice(1);
      selectedMessageIndex = null;
      input = '';
      status = 'History cleared.';
      scrollToBottom();
      redraw();
      return;
    }
    void sendMessage(message);
    return;
  }
  if (event.text) {
    input += event.text;
    redraw();
  }
}
app = render(view(), {
  width,
  height,
  input: true,
  mouse: true,
  onEvent: handleEvent
});
await finished;
