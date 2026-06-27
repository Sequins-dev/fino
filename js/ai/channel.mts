/**
 * Channel adapters for exposing agents over application transports.
 *
 * `agentDriver()` adapts an `Agent` plus optional checkpoint store into a
 * request/reply interface. HTTP, webhook, and WebSocket channel helpers turn
 * that interface into route handlers for application servers.
 */

import type { Agent } from 'fino:ai/agent';
import { streamText } from 'fino:ai/agent';
import type { CheckpointStore } from 'fino:ai/session';
import { Session, session } from 'fino:ai/session';
import { App } from 'fino:net/http/app';
import { serve } from 'fino:net/http/server';
import type { ServeServer } from 'fino:net/http/server';

/**
 * Transport-neutral inbound channel message.
 */
export interface ChannelMessage {
  text: string;
  threadId?: string;
  [key: string]: unknown;
}

/**
 * Transport-neutral reply returned by an agent channel.
 */
export interface ChannelReply {
  text: string;
  runId?: string;
  status?: string;
  resumeToken?: string;
}

/**
 * Transport-neutral driver for sending, streaming, and resuming agent work.
 */
export interface AgentDriver {
  handle(msg: ChannelMessage): Promise<ChannelReply>;
  stream(msg: ChannelMessage): AsyncIterable<string>;
  /**
   * Resume a suspended run.
   *
   * Pass `{ runId, resumeToken, value }` when a checkpoint store is configured
   * so the driver can reload suspended state after process restart. The
   * token-only overload is retained for in-memory stateless drivers.
   */
  resume(resume: string | { runId: string; resumeToken: string; value: unknown }, value?: unknown): Promise<ChannelReply>;
}

/**
 * Options for `agentDriver()`.
 */
export interface AgentDriverOptions {
  agent: Agent;
  store?: CheckpointStore;
  threadId?: string;
}

/**
 * Route descriptor returned by channel helpers.
 */
export interface Channel {
  mount(app: App): void;
  listen(opts: { port: number; hostname?: string }): ServeServer;
}

/**
 * Create a transport-neutral agent driver.
 */
export function agentDriver(opts: AgentDriverOptions): AgentDriver {
  const { agent, store, threadId } = opts;
  const suspended = new Map<string, Session>();

  return {
    async handle(msg: ChannelMessage): Promise<ChannelReply> {
      const input = msg.text;
      if (store) {
        const sess = session({ store, agent, threadId: msg.threadId ?? threadId });
        const result = await sess.start(input);
        const reply: ChannelReply = {
          text: result.text ?? '',
          runId: result.runId,
          status: result.status,
        };
        if (result.status === 'suspended' && result.state.suspendedOn?.token) {
          const token = result.state.suspendedOn.token;
          reply.resumeToken = token;
          suspended.set(token, sess);
        }
        return reply;
      }
      const result = await agent.generate(input);
      return { text: result.text };
    },

    stream(msg: ChannelMessage): AsyncIterable<string> {
      return streamText(agent.stream(msg.text));
    },

    async resume(resume: string | { runId: string; resumeToken: string; value: unknown }, value?: unknown): Promise<ChannelReply> {
      const resumeToken = typeof resume === 'string' ? resume : resume.resumeToken;
      if (store && typeof resume !== 'string') {
        const result = await Session.resumeSuspended({
          store,
          agent,
          threadId,
          runId: resume.runId,
          resumeToken: resume.resumeToken,
          value: resume.value,
        });
        const reply: ChannelReply = {
          text: result.text ?? '',
          runId: result.runId,
          status: result.status,
        };
        if (result.status === 'suspended' && result.state.suspendedOn?.token) {
          reply.resumeToken = result.state.suspendedOn.token;
        }
        return reply;
      }

      const sess = suspended.get(resumeToken);
      if (!sess) {
        throw new Error(`No suspended session for token ${resumeToken}`);
      }
      suspended.delete(resumeToken);
      const result = await sess.resume(resumeToken, value);
      const reply: ChannelReply = {
        text: result.text ?? '',
        runId: result.runId,
        status: result.status,
      };
      if (result.status === 'suspended' && result.state.suspendedOn?.token) {
        const token = result.state.suspendedOn.token;
        reply.resumeToken = token;
        suspended.set(token, sess);
      }
      return reply;
    },
  };
}

/**
 * Options for `httpChannel()`.
 */
export interface HttpChannelOptions {
  path?: string;
  app?: App;
}

/**
 * Create an HTTP request/reply channel.
 */
export function httpChannel(driver: AgentDriver, opts: HttpChannelOptions = {}): Channel {
  const path = opts.path ?? '/chat';

  function mount(app: App): void {
    app.post(path, async (ctx) => {
      const body = await ctx.request.json() as ChannelMessage & { resumeToken?: string };
      try {
        let reply: ChannelReply;
        if (body.resumeToken) {
          reply = body.runId
            ? await driver.resume({ runId: body.runId as string, resumeToken: body.resumeToken, value: body.text })
            : await driver.resume(body.resumeToken, body.text);
        } else {
          reply = await driver.handle(body);
        }
        return Response.json(reply);
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 500 });
      }
    });
  }

  function listen(listenOpts: { port: number; hostname?: string }): ServeServer {
    const app = opts.app ?? new App();
    mount(app);
    return app.listen(listenOpts);
  }

  return { mount, listen };
}

/**
 * Options for `webhookChannel()`.
 */
export interface WebhookChannelOptions {
  path: string;
  verify?: (req: Request) => boolean | Promise<boolean>;
}

/**
 * Create a fire-and-forget webhook channel with caller-provided verification.
 */
export function webhookChannel(driver: AgentDriver, opts: WebhookChannelOptions): Channel {
  const { path, verify } = opts;

  function mount(app: App): void {
    app.post(path, async (ctx) => {
      if (verify) {
        const ok = await verify(ctx.request);
        if (!ok) return new Response('Unauthorized', { status: 401 });
      }
      const body = await ctx.request.json() as ChannelMessage;
      void driver.handle(body).catch(() => {});
      return new Response(null, { status: 202 });
    });
  }

  function listen(listenOpts: { port: number; hostname?: string }): ServeServer {
    const app = new App();
    mount(app);
    return app.listen(listenOpts);
  }

  return { mount, listen };
}

/**
 * Options for `websocketChannel()`.
 */
export interface WebSocketChannelOptions {
  path?: string;
}

/**
 * Create a WebSocket streaming channel.
 */
export function websocketChannel(driver: AgentDriver, opts: WebSocketChannelOptions = {}): Channel {
  const path = opts.path ?? '/chat';

  function mount(app: App): void {
    app.websocket(path, async (socket) => {
      socket.addEventListener('message', (event) => {
        const text = (event as MessageEvent<string>).data;
        void (async () => {
          try {
            for await (const chunk of driver.stream({ text })) {
              await socket.send(chunk);
            }
            await socket.send('\x00');
          } catch (err) {
            await socket.send(`\x01${(err as Error).message}`);
          }
        })();
      });
    });
  }

  function listen(listenOpts: { port: number; hostname?: string }): ServeServer {
    return serve(listenOpts, async (incoming) => {
      if (incoming.kind === 'websocket') {
        const socket = await incoming.accept();
        socket.addEventListener('message', (event) => {
          const text = (event as MessageEvent<string>).data;
          void (async () => {
            try {
              for await (const chunk of driver.stream({ text })) {
                await socket.send(chunk);
              }
              await socket.send('\x00');
            } catch (err) {
              await socket.send(`\x01${(err as Error).message}`);
            }
          })();
        });
        return;
      }
      await incoming.reject(new Response('Not Found', { status: 404 }));
    });
  }

  return { mount, listen };
}
