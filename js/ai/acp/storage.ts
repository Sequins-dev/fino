/**
 * internal:ai/acp/storage — ACP metadata codecs over the shared conversation store.
 *
 * Stored history remains owned by `fino:ai/session`; this module only maps ACP
 * session metadata to and from that generic thread representation.
 *
 * @internal
 */
import { MessageHistory, type MessageHistorySnapshot } from 'fino:ai/context';
import type { Usage } from 'fino:ai/model';
import type { ThreadState } from 'fino:ai/session';
import { isRecord } from 'internal:ai/acp/codec';
import type { AcpMeta, AcpSessionConfigOption, AcpSessionModeState } from 'internal:ai/acp/schema';

export interface AcpStoredSession {
  sessionId: string;
  cwd: string;
  additionalDirectories: string[];
  title?: string;
  createdAt: number;
  updatedAt: string;
  history: MessageHistorySnapshot;
  modes?: AcpSessionModeState;
  configOptions: AcpSessionConfigOption[];
  usage: Usage;
  cost?: number;
  storeVersion?: string;
  _meta?: AcpMeta;
}
const ACP_THREAD_KIND = 'fino:acp:v1';
interface AcpThreadMetadata extends Record<string, unknown> {
  kind: typeof ACP_THREAD_KIND;
  cwd: string;
  additionalDirectories: string[];
  title?: string;
  modes?: AcpSessionModeState;
  configOptions: AcpSessionConfigOption[];
  usage: Usage;
  cost?: number;
  _meta?: AcpMeta;
}
export function acpThreadMetadata(value: unknown): AcpThreadMetadata | null {
  if (!isRecord(value) || value.kind !== ACP_THREAD_KIND || typeof value.cwd !== 'string') {
    return null;
  }
  if (
    !Array.isArray(value.additionalDirectories) ||
    value.additionalDirectories.some((path) => typeof path !== 'string') ||
    !Array.isArray(value.configOptions) ||
    !isRecord(value.usage)
  ) {
    return null;
  }
  return structuredClone(value) as AcpThreadMetadata;
}
export function threadMetadata(session: AcpStoredSession): AcpThreadMetadata {
  return {
    kind: ACP_THREAD_KIND,
    cwd: session.cwd,
    additionalDirectories: [...session.additionalDirectories],
    ...(session.title !== undefined ? { title: session.title } : {}),
    ...(session.modes !== undefined ? { modes: structuredClone(session.modes) } : {}),
    configOptions: structuredClone(session.configOptions),
    usage: structuredClone(session.usage),
    ...(session.cost !== undefined ? { cost: session.cost } : {}),
    ...(session._meta !== undefined ? { _meta: structuredClone(session._meta) } : {}),
  };
}
export function storedSession(
  thread: ThreadState,
  history: MessageHistory,
): AcpStoredSession | null {
  const metadata = acpThreadMetadata(thread.metadata);
  if (!metadata || thread.storeVersion === undefined) return null;
  return {
    sessionId: thread.threadId,
    cwd: metadata.cwd,
    additionalDirectories: [...metadata.additionalDirectories],
    ...(metadata.title !== undefined ? { title: metadata.title } : {}),
    createdAt: thread.createdAt,
    updatedAt: new Date(thread.updatedAt).toISOString(),
    history: history.toSnapshot(),
    ...(metadata.modes !== undefined ? { modes: structuredClone(metadata.modes) } : {}),
    configOptions: structuredClone(metadata.configOptions),
    usage: structuredClone(metadata.usage),
    ...(metadata.cost !== undefined ? { cost: metadata.cost } : {}),
    storeVersion: thread.storeVersion,
    ...(metadata._meta !== undefined ? { _meta: structuredClone(metadata._meta) } : {}),
  };
}
