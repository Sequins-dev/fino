/**
 * internal:ai/acp/client — agent-side client for negotiated ACP v1 host capabilities.
 *
 * Each instance is bound to one ACP session and borrows its owning server's
 * JSON-RPC peer. Closing the server invalidates subsequent client operations.
 */
import { INVALID_PARAMS, INVALID_REQUEST, JsonRpcError, type JsonRpcPeer } from 'fino:jsonrpc';
import {
  connectionClosed,
  hasSensitiveFormField,
  invalidParams,
  isRecord,
  parseUrl,
  requireAbsolutePath,
} from 'internal:ai/acp/codec';
import type {
  AcpClientCapabilities,
  AcpCreateTerminalOptions,
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpMeta,
  AcpSessionUpdate,
  AcpTerminalOutput,
} from 'internal:ai/acp/schema';

/**
 * Agent-side view of one negotiated ACP client.
 *
 * Instances are session-bound. Besides exposing every client request in the
 * stable protocol, the ACP server automatically converts negotiated file,
 * terminal, and elicitation capabilities into model tools.
 */
export class AcpClient {
  #sessionId: string;
  #capabilities: AcpClientCapabilities;
  #peer: () => JsonRpcPeer | null;
  #urlElicitations: Set<string>;
  /** @internal Constructed by `AcpServer`. */
  constructor(
    sessionId: string,
    capabilities: AcpClientCapabilities,
    peer: () => JsonRpcPeer | null,
    urlElicitations: Set<string>,
  ) {
    this.#sessionId = sessionId;
    this.#capabilities = capabilities;
    this.#peer = peer;
    this.#urlElicitations = urlElicitations;
  }
  /** Negotiated client capabilities. */
  get capabilities(): AcpClientCapabilities {
    return structuredClone(this.#capabilities);
  }
  /** Session id automatically attached to session-scoped client requests. */
  get sessionId(): string {
    return this.#sessionId;
  }
  #requirePeer(): JsonRpcPeer {
    const peer = this.#peer();
    if (!peer) throw connectionClosed();
    return peer;
  }
  #requireCapability(enabled: boolean, name: string): void {
    if (!enabled) throw new JsonRpcError(`ACP client does not support ${name}`, INVALID_REQUEST);
  }
  /** Send any stable session update. */
  async update(update: AcpSessionUpdate, meta?: AcpMeta): Promise<void> {
    await this.#requirePeer().notify('session/update', {
      sessionId: this.#sessionId,
      update: structuredClone(update),
      ...(meta !== undefined ? { _meta: meta } : {}),
    });
  }
  /** Read a text file through the negotiated client filesystem capability. */
  async readTextFile(
    path: string,
    opts: { line?: number; limit?: number; meta?: AcpMeta; signal?: AbortSignal } = {},
  ): Promise<{ content: string; _meta?: AcpMeta }> {
    this.#requireCapability(this.#capabilities.fs?.readTextFile === true, 'fs.readTextFile');
    requireAbsolutePath(path, 'path');
    return (await this.#requirePeer().call(
      'fs/read_text_file',
      {
        sessionId: this.#sessionId,
        path,
        ...(opts.line !== undefined ? { line: opts.line } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.meta !== undefined ? { _meta: opts.meta } : {}),
      },
      { signal: opts.signal },
    )) as { content: string; _meta?: AcpMeta };
  }
  /** Write a text file through the negotiated client filesystem capability. */
  async writeTextFile(
    path: string,
    content: string,
    opts: { meta?: AcpMeta; signal?: AbortSignal } = {},
  ): Promise<{ _meta?: AcpMeta }> {
    this.#requireCapability(this.#capabilities.fs?.writeTextFile === true, 'fs.writeTextFile');
    requireAbsolutePath(path, 'path');
    return (await this.#requirePeer().call(
      'fs/write_text_file',
      {
        sessionId: this.#sessionId,
        path,
        content,
        ...(opts.meta !== undefined ? { _meta: opts.meta } : {}),
      },
      { signal: opts.signal },
    )) as { _meta?: AcpMeta };
  }
  /** Create a client-hosted terminal. */
  async createTerminal(
    opts: AcpCreateTerminalOptions,
    signal?: AbortSignal,
  ): Promise<{ terminalId: string; _meta?: AcpMeta }> {
    this.#requireCapability(this.#capabilities.terminal === true, 'terminal');
    if (opts.cwd !== undefined && opts.cwd !== null) requireAbsolutePath(opts.cwd, 'cwd');
    return (await this.#requirePeer().call(
      'terminal/create',
      { sessionId: this.#sessionId, ...structuredClone(opts) },
      { signal },
    )) as { terminalId: string; _meta?: AcpMeta };
  }
  /** Read current output from a client-hosted terminal. */
  async terminalOutput(terminalId: string, signal?: AbortSignal): Promise<AcpTerminalOutput> {
    this.#requireCapability(this.#capabilities.terminal === true, 'terminal');
    return (await this.#requirePeer().call(
      'terminal/output',
      { sessionId: this.#sessionId, terminalId },
      { signal },
    )) as AcpTerminalOutput;
  }
  /** Wait until a client-hosted terminal exits. */
  async waitForTerminalExit(
    terminalId: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode?: number | null; signal?: string | null; _meta?: AcpMeta }> {
    this.#requireCapability(this.#capabilities.terminal === true, 'terminal');
    return (await this.#requirePeer().call(
      'terminal/wait_for_exit',
      { sessionId: this.#sessionId, terminalId },
      { signal },
    )) as { exitCode?: number | null; signal?: string | null; _meta?: AcpMeta };
  }
  /** Kill a client-hosted terminal process. */
  async killTerminal(terminalId: string, signal?: AbortSignal): Promise<void> {
    this.#requireCapability(this.#capabilities.terminal === true, 'terminal');
    await this.#requirePeer().call(
      'terminal/kill',
      { sessionId: this.#sessionId, terminalId },
      { signal },
    );
  }
  /** Release a client-hosted terminal and its retained output. */
  async releaseTerminal(terminalId: string, signal?: AbortSignal): Promise<void> {
    this.#requireCapability(this.#capabilities.terminal === true, 'terminal');
    await this.#requirePeer().call(
      'terminal/release',
      { sessionId: this.#sessionId, terminalId },
      { signal },
    );
  }
  /** Request negotiated structured user input. */
  async elicit(
    request: AcpElicitationRequest,
    signal?: AbortSignal,
  ): Promise<AcpElicitationResponse> {
    if (request.mode === 'form') {
      this.#requireCapability(isRecord(this.#capabilities.elicitation?.form), 'elicitation.form');
      if (hasSensitiveFormField(request.requestedSchema)) {
        throw new JsonRpcError(
          'ACP form elicitation must not request sensitive credentials',
          INVALID_REQUEST,
        );
      }
    } else if (request.mode === 'url') {
      this.#requireCapability(isRecord(this.#capabilities.elicitation?.url), 'elicitation.url');
      parseUrl(request.url, 'url');
      if (this.#urlElicitations.has(request.elicitationId)) {
        throw new JsonRpcError(
          `Duplicate elicitation id: ${request.elicitationId}`,
          INVALID_REQUEST,
        );
      }
      this.#urlElicitations.add(request.elicitationId);
    } else if (!request.mode.startsWith('_')) {
      invalidParams('Custom ACP elicitation modes must begin with _');
    }
    const scoped =
      request.sessionId === undefined && request.requestId === undefined
        ? { ...request, sessionId: this.#sessionId }
        : request;
    try {
      return (await this.#requirePeer().call('elicitation/create', scoped, {
        signal,
      })) as AcpElicitationResponse;
    } catch (error) {
      if (request.mode === 'url') this.#urlElicitations.delete(request.elicitationId);
      throw error;
    }
  }
  /** Tell the client that a URL elicitation has completed. */
  async completeElicitation(elicitationId: string, meta?: AcpMeta): Promise<void> {
    if (!this.#urlElicitations.delete(elicitationId)) {
      throw new JsonRpcError(`Unknown elicitation id: ${elicitationId}`, INVALID_PARAMS);
    }
    await this.#requirePeer().notify('elicitation/complete', {
      elicitationId,
      ...(meta !== undefined ? { _meta: meta } : {}),
    });
  }
  /** Call a client extension method. Extension names must begin with `_`. */
  extension(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!method.startsWith('_')) invalidParams('ACP extension methods must begin with _');
    return this.#requirePeer().call(method, params, { signal });
  }
  /** Send a client extension notification. Extension names must begin with `_`. */
  async notifyExtension(method: string, params?: unknown): Promise<void> {
    if (!method.startsWith('_')) invalidParams('ACP extension methods must begin with _');
    await this.#requirePeer().notify(method, params);
  }
}
