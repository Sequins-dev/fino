/**
 * fino:commands/slides — serve a file-backed presentation from the CLI.
 *
 * `fino slides talk.mdx` serves the audience at `/` and the presenter console
 * at `/_presenter`. The deck is loaded before the listener is announced and
 * file-backed presentations update live when their source changes. The
 * command binds to `127.0.0.1` by default; `--host` explicitly changes the
 * bind address. The presenter route has no authentication, so a public bind
 * also exposes its controls to anyone who can reach the server.
 *
 * ```sh
 * fino slides talk.mdx --port 4000
 * fino slides talk.mdx --host 0.0.0.0
 * ```
 */
import { resolve } from '../file/path.ts';
import { App } from '../net/http/app.ts';
import { cwd } from '../process.ts';
import { Task } from '../task.ts';
import { Presentation } from '../ui/slides.ts';

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveWait) => {
    signal.addEventListener('abort', () => resolveWait(), { once: true });
  });
}

/** Serve one MDX or component-module slide deck until the command is stopped. */
const command = new Task({
  name: 'slides',
  description: 'Serve an MDX presentation with audience and presenter views',
  outputMode: 'text',
  run: async function runSlidesCommand(
    input: { deck?: unknown; host?: unknown; port?: unknown },
    ctx,
  ) {
    const deck = input.deck;
    if (typeof deck !== 'string' || deck.length === 0)
      throw new TypeError('fino slides: a deck file is required');
    if (ctx.writer.mode !== 'text') throw new TypeError('fino slides: text output is required');
    const host = input.host === undefined ? '127.0.0.1' : input.host;
    if (typeof host !== 'string' || host.trim().length === 0)
      throw new TypeError('fino slides: --host must be a nonempty address');
    const port = input.port === undefined ? 3000 : input.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535)
      throw new TypeError('fino slides: --port must be an integer from 0 to 65535');

    const presentation = new Presentation(resolve(ctx.cwd ?? cwd(), deck).toString());
    let loaded = false;
    let server: ReturnType<App['listen']> | undefined;
    try {
      await presentation.ready;
      loaded = true;
      const app = new App({ name: 'Fino Slides' });
      app.route('/').mount(presentation.router());
      server = app.listen({ hostname: host, port });
      await server.ready;
      const address = host.includes(':') ? `[${host}]` : host;
      const origin = `http://${address}:${server.port}`;
      await ctx.writer.writeText(`Audience:  ${origin}/\n`);
      await ctx.writer.writeText(`Presenter: ${origin}/_presenter\n`);
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1')
        await ctx.writer.writeText('Presenter controls are reachable on the bound network.\n');
      await waitForAbort(ctx.signal);
    } finally {
      if (server) await server.close();
      if (loaded) await presentation.close();
    }
  },
  cli: {
    options: [
      {
        flags: '--host',
        type: 'string',
        description: 'Bind address (default 127.0.0.1; public binds expose presenter controls)',
      },
      {
        flags: '--port',
        type: 'number',
        description: 'HTTP port (default 3000; 0 selects an available port)',
      },
    ],
    positionals: [
      {
        name: 'deck',
        type: 'string',
        required: true,
        description: 'MDX or presentation module file',
      },
    ],
  },
});

export { command as default };
