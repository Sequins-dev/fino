/**
 * fino:commands/gallery — reusable `fino gallery` command task.
 *
 * Launches the component gallery: a storybook for `fino:ui/components` (and
 * any user components) that renders the same stories in the terminal and over
 * HTTP. With no arguments it shows the built-in catalog stories in a live
 * TUI; pass a stories module to view your own components in isolation, and
 * `--html` to serve the gallery to a browser instead.
 *
 * A stories module default-exports story groups (or exports them as
 * `stories`):
 *
 * ```ts no_run
 * /** @jsxImportSource fino:ui *\/
 * import type { StoryGroup } from 'fino:ui/gallery';
 * import { MyCard } from './card.tsx';
 *
 * export default [
 *   {
 *     title: 'Cards',
 *     stories: [
 *       {
 *         key: 'card',
 *         name: 'MyCard',
 *         controls: { title: { type: 'text', default: 'Hello' } },
 *         view: (args) => MyCard({ title: String(args.title) }),
 *       },
 *     ],
 *   },
 * ] satisfies StoryGroup[];
 * ```
 *
 * ```sh
 * fino gallery                    # built-in catalog, in the terminal
 * fino gallery stories.tsx        # your components, in the terminal
 * fino gallery --html --port 4000 # serve to a browser
 * ```
 */
import { Task } from '../task.ts';
import { resolve } from '../file/path.ts';
import { catalogStories, runGalleryHtml, runGalleryTui } from 'fino:ui/gallery';
import type { StoryGroup } from 'fino:ui/gallery';

async function loadStories(path: string, cwd: string): Promise<StoryGroup[]> {
  const target = resolve(cwd, path).toString();
  const module = (await import(target)) as { default?: unknown; stories?: unknown };
  const groups = module.default ?? module.stories;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error(`${path} must export story groups (default or 'stories')`);
  }
  return groups as StoryGroup[];
}

/**
 * The `gallery` command task, mounted as a subcommand by the root Fino CLI.
 *
 * In terminal mode the task resolves when the gallery exits (`q`). In
 * `--html` mode it prints the address and serves until interrupted.
 */
const command = new Task({
  name: 'gallery',
  description: 'Browse UI components in a terminal or browser storybook',
  outputMode: 'text',
  run: async function runGalleryCommand(
    input: {
      stories?: unknown;
      html?: unknown;
      port?: unknown;
    },
    ctx,
  ) {
    const groups =
      typeof input.stories === 'string' && input.stories.length > 0
        ? await loadStories(input.stories, ctx.cwd)
        : catalogStories();
    if (input.html === true) {
      const port = typeof input.port === 'number' ? input.port : 3080;
      const server = runGalleryHtml({ port, groups });
      await server.ready;
      await ctx.writer.writeText(`gallery serving on http://127.0.0.1:${server.port}\n`);
      // Serve until the process is interrupted; the listener holds the loop.
      await new Promise<void>(() => {});
      return;
    }
    await runGalleryTui(groups);
  },
  cli: {
    options: [
      {
        flags: '--html',
        type: 'boolean',
        description: 'Serve the gallery over HTTP instead of the terminal',
      },
      {
        flags: '--port',
        type: 'number',
        description: 'Port for --html mode (default 3080)',
      },
    ],
    positionals: [
      {
        name: 'stories',
        type: 'string',
        description: 'Path to a module exporting story groups',
      },
    ],
  },
});
export { command as default };
