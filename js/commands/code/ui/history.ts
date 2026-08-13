/**
 * fino:commands/code/ui/history — durable history to transcript entries.
 *
 * Pure conversions from stored conversation data (`ModelMessage[]` plus
 * `CodeTurnRecord[]`) into the transcript-entry form the block renderers
 * consume — used to replay any view into scrollback: the main session, a
 * sub-agent thread, or an engine-less archived session.
 */
import type { ModelMessage } from 'fino:ai/model';
import type { CodeTurnRecord } from 'fino:commands/code/engine';
import { contentText, previewText } from 'fino:commands/code/transcript';
import { turnMarkerText, type TranscriptEntry } from 'fino:commands/code/ui/blocks';

/**
 * Rebuild transcript entries from a stored conversation.
 *
 * Turn records carry the history length they ended at, so their markers land
 * between the same messages they did when the turns ran. Synthetic
 * `[subagent settlement]` user messages replay as notices, and tool results
 * are folded back onto the tool-use entries they answer.
 */
export function entriesFromHistory(
  messages: ModelMessage[],
  turns: CodeTurnRecord[] = [],
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const toolEntries = new Map<string, TranscriptEntry>();
  const marks = new Map<number, CodeTurnRecord[]>();
  for (const turn of turns) {
    const at = Math.min(turn.messages, messages.length);
    marks.set(at, [...(marks.get(at) ?? []), turn]);
  }
  const flushMarks = (index: number): void => {
    for (const turn of marks.get(index) ?? []) {
      entries.push({ kind: 'turn', text: turnMarkerText(turn) });
    }
  };
  for (let index = 0; index < messages.length; index++) {
    flushMarks(index);
    const message = messages[index]!;
    if (message.role === 'user' && typeof message.content === 'string') {
      const synthetic = message.content.startsWith('[subagent settlement]');
      entries.push({ kind: synthetic ? 'notice' : 'user', text: message.content });
    } else if (message.role === 'user' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'tool_result') {
          const entry = toolEntries.get(part.toolCallId);
          if (entry) {
            entry.outputText = previewText(contentText(part.content));
            if (part.isError) entry.toolState = 'error';
          }
        }
      }
    } else if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        entries.push({ kind: 'assistant', text: message.content });
      } else {
        for (const part of message.content) {
          if (part.type === 'text' && part.text.trim().length > 0) {
            entries.push({ kind: 'assistant', text: part.text });
          } else if (part.type === 'tool_use') {
            const entry: TranscriptEntry = {
              kind: 'tool',
              text: part.name,
              toolState: 'ok',
              toolId: part.id,
              argsValue: part.args ?? {},
            };
            toolEntries.set(part.id, entry);
            entries.push(entry);
          }
        }
      }
    }
  }
  flushMarks(messages.length);
  return entries;
}

/**
 * Replace a view's entries with replayed history, keeping host-pinned
 * entries (an intro banner at the top, status notes at the bottom) that are
 * not part of the durable record.
 */
export function seedEntries(
  current: TranscriptEntry[],
  messages: ModelMessage[],
  turns: CodeTurnRecord[] = [],
): TranscriptEntry[] {
  const pinnedTop = current.filter((entry) => entry.pin === 'top');
  const pinnedBottom = current.filter((entry) => entry.pin === 'bottom');
  return [...pinnedTop, ...entriesFromHistory(messages, turns), ...pinnedBottom];
}

/**
 * Everything the user typed on a thread, for up-arrow recall across the
 * processes that typed it. Synthetic settlement messages are excluded.
 */
export function inputHistoryFromMessages(messages: ModelMessage[]): string[] {
  return messages
    .filter(
      (message): message is ModelMessage & { content: string } =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        !message.content.startsWith('[subagent settlement]'),
    )
    .map((message) => message.content);
}
