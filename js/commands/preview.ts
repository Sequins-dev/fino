/**
 * fino:commands/preview — reusable `fino preview` command task.
 *
 * Launches the component preview: a browsable catalog of `fino:ui/components` (and
 * any user components) that renders the same previews in the terminal and over
 * HTTP. With no arguments it shows the built-in catalog previews in a live
 * TUI; pass a previews module to view your own components in isolation, and
 * `--html` to serve the preview to a browser instead.
 *
 * A previews module default-exports preview groups (or exports them as
 * `previews`):
 *
 * ```ts no_run
 * /** @jsxImportSource fino:ui *\/
 * import type { PreviewGroup } from 'fino:ui/preview';
 * import { MyCard } from './card.tsx';
 *
 * export default [
 *   {
 *     title: 'Cards',
 *     previews: [
 *       {
 *         key: 'card',
 *         name: 'MyCard',
 *         controls: { title: { type: 'text', default: 'Hello' } },
 *         view: (args) => MyCard({ title: String(args.title) }),
 *       },
 *     ],
 *   },
 * ] satisfies PreviewGroup[];
 * ```
 *
 * ```sh
 * fino preview                    # built-in catalog, in the terminal
 * fino preview previews.tsx        # your components, in the terminal
 * fino preview --html --port 4000 # serve to a browser
 * ```
 */
import { Task } from '../task.ts';
import { resolve } from '../file/path.ts';
import { catalogPreviews, runPreviewHtml, runPreviewTui } from 'fino:ui/preview';
import type { PreviewGroup } from 'fino:ui/preview';

async function loadPreviews(path: string, cwd: string): Promise<PreviewGroup[]> {
  const target = resolve(cwd, path).toString();
  const module = (await import(target)) as { default?: unknown; previews?: unknown };
  const groups = module.default ?? module.previews;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error(`${path} must export preview groups (default or 'previews')`);
  }
  return groups as PreviewGroup[];
}

/**
 * The `preview` command task, mounted as a subcommand by the root Fino CLI.
 *
 * In terminal mode the task resolves when the preview exits (`q`). In
 * `--html` mode it prints the address and serves until interrupted.
 */
const command = new Task({
  name: 'preview',
  description: 'Browse UI components in a terminal or a browser',
  outputMode: 'text',
  run: async function runPreviewCommand(
    input: {
      previews?: unknown;
      html?: unknown;
      port?: unknown;
    },
    ctx,
  ) {
    const groups =
      typeof input.previews === 'string' && input.previews.length > 0
        ? await loadPreviews(input.previews, ctx.cwd)
        : catalogPreviews();
    if (input.html === true) {
      const port = typeof input.port === 'number' ? input.port : 3080;
      const server = runPreviewHtml({ port, groups });
      await server.ready;
      await ctx.writer.writeText(`preview serving on http://127.0.0.1:${server.port}\n`);
      // Serve until the process is interrupted; the listener holds the loop.
      await new Promise<void>(() => {});
      return;
    }
    await runPreviewTui(groups);
  },
  cli: {
    options: [
      {
        flags: '--html',
        type: 'boolean',
        description: 'Serve the preview over HTTP instead of the terminal',
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
        description: 'Path to a module exporting preview groups',
      },
    ],
  },
});
export { command as default };
