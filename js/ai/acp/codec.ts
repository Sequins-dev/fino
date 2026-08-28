/**
 * internal:ai/acp/codec — ACP v1 validation and model-conversion helpers.
 *
 * The functions in this module are stateless protocol-boundary codecs shared
 * by the client and server implementations.
 *
 * @internal
 */
import { INTERNAL_ERROR, INVALID_PARAMS, JsonRpcError } from 'fino:jsonrpc';
import type { ContentPart, ModelMessage, StopReason } from 'fino:ai/model';
import type {
  AcpClientCapabilities,
  AcpContentBlock,
  AcpMcpServer,
  AcpMeta,
  AcpSessionConfigOption,
  AcpToolKind,
} from 'internal:ai/acp/schema';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalidParams(message: string): never {
  throw new JsonRpcError(message, INVALID_PARAMS);
}
function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) invalidParams(`${name} must be an object`);
  return value;
}
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') invalidParams(`${name} must be a string`);
  return value;
}
function requireAbsolutePath(value: unknown, name: string): string {
  const path = requireString(value, name);
  if (!path.startsWith('/')) invalidParams(`${name} must be an absolute path`);
  return path;
}
function parseStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    invalidParams(`${name} must be an array of strings`);
  }
  return [...(value as string[])];
}
function parseAbsolutePaths(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  return parseStringArray(value, name).map((path, index) =>
    requireAbsolutePath(path, `${name}[${index}]`),
  );
}
function parsePairs(
  value: unknown,
  name: string,
): Array<{ name: string; value: string; _meta?: AcpMeta }> {
  if (!Array.isArray(value)) invalidParams(`${name} must be an array`);
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const item = requireRecord(raw, `${name}[${index}]`);
    const pairName = requireString(item.name, `${name}[${index}].name`);
    if (seen.has(pairName)) invalidParams(`${name} contains duplicate ${pairName}`);
    seen.add(pairName);
    return {
      name: pairName,
      value: requireString(item.value, `${name}[${index}].value`),
      ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
    };
  });
}
function parseUrl(value: unknown, name: string): string {
  const url = requireString(value, name);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalidParams(`${name} must be an absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    invalidParams(`${name} must use HTTP or HTTPS`);
  }
  return url;
}
function parseMcpServer(value: unknown, index: number): AcpMcpServer {
  const server = requireRecord(value, `mcpServers[${index}]`);
  const name = requireString(server.name, `mcpServers[${index}].name`);
  if (server.type === 'http' || server.type === 'sse') {
    return {
      type: server.type,
      name,
      url: parseUrl(server.url, `mcpServers[${index}].url`),
      headers: parsePairs(server.headers, `mcpServers[${index}].headers`),
      ...(isRecord(server._meta) ? { _meta: server._meta } : {}),
    };
  }
  if (server.type !== undefined) invalidParams(`mcpServers[${index}].type is unsupported`);
  return {
    name,
    command: requireAbsolutePath(server.command, `mcpServers[${index}].command`),
    args: parseStringArray(server.args, `mcpServers[${index}].args`),
    env: parsePairs(server.env ?? [], `mcpServers[${index}].env`),
    ...(isRecord(server._meta) ? { _meta: server._meta } : {}),
  };
}
function parseContent(value: unknown, index: number): AcpContentBlock {
  const name = `prompt[${index}]`;
  const block = requireRecord(value, name);
  switch (block.type) {
    case 'text':
      requireString(block.text, `${name}.text`);
      break;
    case 'image':
    case 'audio':
      requireString(block.data, `${name}.data`);
      requireString(block.mimeType, `${name}.mimeType`);
      break;
    case 'resource': {
      const resource = requireRecord(block.resource, `${name}.resource`);
      requireString(resource.uri, `${name}.resource.uri`);
      const hasText = typeof resource.text === 'string';
      const hasBlob = typeof resource.blob === 'string';
      if (hasText === hasBlob) {
        invalidParams(`${name}.resource must contain exactly one of text or blob`);
      }
      break;
    }
    case 'resource_link':
      requireString(block.name, `${name}.name`);
      requireString(block.uri, `${name}.uri`);
      break;
    default:
      invalidParams(`${name}.type is not supported`);
  }
  return structuredClone(block) as AcpContentBlock;
}
function promptMessage(blocks: AcpContentBlock[]): ModelMessage {
  const content: ContentPart[] = blocks.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'image':
        return { type: 'image', mediaType: block.mimeType, data: block.data };
      case 'audio':
        return { type: 'audio', mediaType: block.mimeType, data: block.data };
      case 'resource':
        if ('text' in block.resource) {
          return {
            type: 'text',
            text: `<resource uri="${block.resource.uri}">\n${block.resource.text}\n</resource>`,
          };
        }
        return {
          type: 'document',
          mediaType: block.resource.mimeType ?? 'application/octet-stream',
          data: block.resource.blob,
          name: block.resource.uri,
        };
      case 'resource_link': {
        const label = block.title ?? block.name;
        const description = block.description ? ` — ${block.description}` : '';
        return { type: 'text', text: `[${label}](${block.uri})${description}` };
      }
    }
  });
  return { role: 'user', content };
}
function modelPartToAcp(part: ContentPart): AcpContentBlock {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
      return { type: 'image', data: part.data, mimeType: part.mediaType };
    case 'audio':
      return { type: 'audio', data: part.data, mimeType: part.mediaType };
    case 'document':
      return {
        type: 'resource',
        resource: {
          uri: part.name ? `file://${part.name}` : 'document://inline',
          mimeType: part.mediaType,
          blob: part.data,
        },
      };
    case 'tool_use':
    case 'tool_result':
      return { type: 'text', text: JSON.stringify(part) };
  }
}
function modelContentToAcp(content: string | ContentPart[]): AcpContentBlock[] {
  return typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content.map(modelPartToAcp);
}
function acpStopReason(
  reason: StopReason,
): 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' {
  switch (reason) {
    case 'max_tokens':
      return 'max_tokens';
    case 'tool_use':
      return 'max_turn_requests';
    case 'refusal':
    case 'content_filter':
      return 'refusal';
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'error':
      throw new JsonRpcError('Agent stopped with an error', INTERNAL_ERROR);
  }
}
function normalizeClientCapabilities(value: unknown): AcpClientCapabilities {
  const input = isRecord(value) ? value : {};
  const fs = isRecord(input.fs) ? input.fs : {};
  const auth = isRecord(input.auth) ? input.auth : {};
  const elicitation = isRecord(input.elicitation) ? input.elicitation : null;
  const session = isRecord(input.session) ? input.session : null;
  const configOptions = session && isRecord(session.configOptions) ? session.configOptions : null;
  return {
    fs: {
      readTextFile: fs.readTextFile === true,
      writeTextFile: fs.writeTextFile === true,
      ...(isRecord(fs._meta) ? { _meta: fs._meta } : {}),
    },
    terminal: input.terminal === true,
    auth: {
      terminal: auth.terminal === true,
      ...(isRecord(auth._meta) ? { _meta: auth._meta } : {}),
    },
    ...(elicitation
      ? {
          elicitation: {
            ...(isRecord(elicitation.form) ? { form: elicitation.form } : {}),
            ...(isRecord(elicitation.url) ? { url: elicitation.url } : {}),
            ...(isRecord(elicitation._meta) ? { _meta: elicitation._meta } : {}),
          },
        }
      : {}),
    ...(session
      ? {
          session: {
            ...(configOptions
              ? {
                  configOptions: {
                    ...(isRecord(configOptions.boolean) ? { boolean: configOptions.boolean } : {}),
                    ...(isRecord(configOptions._meta) ? { _meta: configOptions._meta } : {}),
                  },
                }
              : {}),
            ...(isRecord(session._meta) ? { _meta: session._meta } : {}),
          },
        }
      : {}),
    ...(isRecord(input._meta) ? { _meta: input._meta } : {}),
  };
}
function supportsBooleanConfig(capabilities: AcpClientCapabilities): boolean {
  return isRecord(capabilities.session?.configOptions?.boolean);
}
function filterConfigOptions(
  options: AcpSessionConfigOption[],
  capabilities: AcpClientCapabilities,
): AcpSessionConfigOption[] {
  return structuredClone(
    options.filter((option) => option.type !== 'boolean' || supportsBooleanConfig(capabilities)),
  );
}
function inferToolKind(name: string): AcpToolKind {
  const lower = name.toLowerCase();
  if (lower.includes('read')) return 'read';
  if (lower.includes('write') || lower.includes('edit')) return 'edit';
  if (lower.includes('delete') || lower.includes('remove')) return 'delete';
  if (lower.includes('move') || lower.includes('rename')) return 'move';
  if (lower.includes('search') || lower.includes('find')) return 'search';
  if (lower.includes('terminal') || lower.includes('exec') || lower.includes('run'))
    return 'execute';
  if (lower.includes('fetch') || lower.includes('http')) return 'fetch';
  if (lower.includes('think') || lower.includes('plan')) return 'think';
  return 'other';
}
function hasSensitiveFormField(schema: Record<string, unknown>): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (!isRecord(value) || seen.has(value)) return false;
    seen.add(value);
    if (
      isRecord(value.properties) &&
      Object.keys(value.properties).some((name) =>
        /password|passcode|secret|token|api.?key|private.?key|recovery|payment|card/i.test(name),
      )
    ) {
      return true;
    }
    return Object.values(value).some((child) =>
      Array.isArray(child) ? child.some(visit) : visit(child),
    );
  };
  return visit(schema);
}
function connectionClosed(): JsonRpcError {
  return new JsonRpcError('ACP connection is closed', INTERNAL_ERROR);
}
function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export {
  abortError,
  acpStopReason,
  connectionClosed,
  filterConfigOptions,
  hasSensitiveFormField,
  inferToolKind,
  invalidParams,
  isRecord,
  modelContentToAcp,
  modelPartToAcp,
  normalizeClientCapabilities,
  parseAbsolutePaths,
  parseContent,
  parseMcpServer,
  parseUrl,
  promptMessage,
  requireAbsolutePath,
  requireRecord,
  requireString,
  supportsBooleanConfig,
};
