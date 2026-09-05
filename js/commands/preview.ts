/**
 * fino:commands/preview — reusable `fino preview` command task.
 *
 * The command opens the built-in component catalog in a terminal by default.
 * Pass a module that default-exports `PreviewGroup[]` to inspect application
 * components, or use `--html` for the live server-driven browser runner.
 *
 * ```sh
 * fino preview
 * fino preview ./previews.ts
 * fino preview --html --port 4000
 * ```
 */
import { Task } from '../task.ts';
import { resolve } from '../file/path.ts';
import { catalogPreviews, runPreviewHtml, runPreviewTui } from 'fino:ui/preview';
import type { PreviewGroup } from 'fino:ui/preview';
import { validatePreviewGroups } from 'internal:ui/preview';

async function loadPreviews(path: string, cwd: string): Promise<PreviewGroup[]> {
  const module = (await import(resolve(cwd, path).toString())) as {
    default?: unknown;
    previews?: unknown;
  };
  try {
    return validatePreviewGroups(module.default ?? module.previews);
  } catch (error) {
    throw new TypeError(`${path} does not export valid preview groups`, { cause: error });
  }
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveWait) => {
    signal.addEventListener('abort', resolveWait, { once: true });
  });
}

/** The `preview` subcommand mounted by the root Fino CLI. */
const command = new Task({
  name: 'preview',
  description: 'Browse UI components in a terminal or browser',
  outputMode: 'text',
  run: async function runPreviewCommand(
    input: { previews?: unknown; html?: unknown; port?: unknown },
    ctx,
  ) {
    const groups =
      typeof input.previews === 'string' && input.previews.length > 0
        ? await loadPreviews(input.previews, ctx.cwd)
        : catalogPreviews();
    if (input.html !== true) {
      await runPreviewTui(groups);
      return;
    }
    const server = runPreviewHtml({
      port: typeof input.port === 'number' ? input.port : 3080,
      groups,
    });
    try {
      await server.ready;
      await ctx.writer.writeText(`preview serving on http://127.0.0.1:${server.port}\n`);
      await waitForAbort(ctx.signal);
    } finally {
      await server.close();
    }
  },
  cli: {
    options: [
      {
        flags: '--html',
        type: 'boolean',
        description: 'Serve over HTTP instead of opening the terminal runner',
      },
      {
        flags: '--port',
        type: 'number',
        description: 'Port for --html mode (default 3080)',
      },
    ],
    positionals: [
      {
        name: 'previews',
        type: 'string',
        description: 'Module that default-exports preview groups',
      },
    ],
  },
});

export { command as default };
