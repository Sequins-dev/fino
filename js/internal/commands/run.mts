/**
 * internal/commands/run — internal runtime module.
 *
 * Implements script execution for both `fino run <script>` and the root
 * shortcut `fino <script>`. The module handles path normalization, watch-mode
 * realm creation, and optional OpenTelemetry provider installation from either
 * `--otlp-endpoint` or `OTEL_EXPORTER_OTLP_ENDPOINT` before importing the
 * target script.
 *
 * ```js
 * import { createRunCommand } from 'internal:commands/run';
 * const command = createRunCommand();
 * console.log(command.name);
 * ```
 *
 * @internal
 */

import { Command, type CommandContext } from '../../process/argv.mts';
import { cwd, env } from '../../process.mts';
import { Realm } from '../../realm/index.mts';
import {
  LoggerProvider,
  MeterProvider,
  TracerProvider,
  runWithLoggerProvider,
  runWithMeterProvider,
  runWithTracerProvider,
} from '../../opentelemetry.mts';
import { createCliOtelRuntime } from '../opentelemetry/bootstrap.mts';

function fileUrlFromPath(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let encoded = '';
  for (const byte of bytes) {
    if (
      byte === 0x2f ||
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e
    ) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return 'file://' + encoded;
}

function normalizeScriptSpecifier(script: string): string {
  if (script.startsWith('file://')) return script;
  if (script.startsWith('/')) return fileUrlFromPath(script);
  if (script.startsWith('./') || script.startsWith('../')) return fileUrlFromPath(`${cwd()}/${script}`);
  if (script.includes(':')) return script;
  return fileUrlFromPath(`${cwd()}/./${script}`);
}

function runWithProviders<R>(
  providers: { tracerProvider: TracerProvider; loggerProvider: LoggerProvider; meterProvider: MeterProvider },
  fn: () => R,
): R {
  return runWithTracerProvider(providers.tracerProvider, () =>
    runWithLoggerProvider(providers.loggerProvider, () =>
      runWithMeterProvider(providers.meterProvider, fn)));
}

function optionValue(ctx: CommandContext, key: string): unknown {
  if (ctx.optionProvided(key)) return ctx.options[key];
  if (ctx.root.providedOptions.has(key)) return ctx.root.options[key];
  return ctx.options[key];
}

/**
 * Execute the script referenced by a parsed command context.
 *
 * When no script positional is present, this returns the command help output.
 * With `--watch`, the script runs inside a watched `Realm` and the realm is
 * terminated on `beforeunload`. With an `--otlp-endpoint` option or
 * `OTEL_EXPORTER_OTLP_ENDPOINT`, the script import runs with CLI OpenTelemetry
 * providers installed; otherwise it is imported directly. The CLI flag wins
 * over the environment endpoint, and `OTEL_SDK_DISABLED=true` disables env and
 * flag bootstrap. Import failures and provider bootstrap errors propagate to
 * the caller.
 *
 * ```js
 * import { createRunCommand } from 'internal:commands/run';
 * const command = createRunCommand();
 * await command.parse(['./example.mts']);
 * ```
 *
 * @param ctx Parsed command context from `process/argv`.
 * @returns The imported module result, realm run result, or help text.
 * @internal
 */
export async function runScriptCommand(ctx: CommandContext): Promise<unknown> {
  const script = ctx.args.script;
  if (script === undefined) return ctx.command.help();

  const watchMode = optionValue(ctx, 'watch') === true;
  if (watchMode) {
    const entry = normalizeScriptSpecifier(String(script));
    const realm = new Realm({ entry, watch: true });
    // Let SIGINT / Ctrl-C terminate the watch loop cleanly.
    (globalThis as Record<string, unknown>).addEventListener?.('beforeunload', () => realm.terminate());
    return realm.run();
  }

  const load = () => import(normalizeScriptSpecifier(String(script)));
  if (String(env.OTEL_SDK_DISABLED || '').trim().toLowerCase() === 'true') return load();
  const endpointOption = optionValue(ctx, 'otlp-endpoint');
  const flagEndpoint = typeof endpointOption === 'string' ? endpointOption.trim() : '';
  const envEndpoint = typeof env.OTEL_EXPORTER_OTLP_ENDPOINT === 'string' ? env.OTEL_EXPORTER_OTLP_ENDPOINT.trim() : '';
  const endpoint = flagEndpoint || envEndpoint;
  if (!endpoint) return load();
  return runWithProviders(
    await createCliOtelRuntime(endpoint, String(script), env.FINO_OTEL_DEBUG === '1'),
    load,
  );
}

/**
 * Create the explicit `run` subcommand.
 *
 * The command requires a script positional and supports `--watch` plus
 * `--otlp-endpoint`. Its runtime behavior is delegated to
 * `runScriptCommand()`, so root-level and subcommand script execution stay
 * consistent.
 *
 * ```js
 * import { createRunCommand } from 'internal:commands/run';
 * const run = createRunCommand();
 * await run.parse(['--watch', 'server.mts']);
 * ```
 *
 * @returns A configured `Command` instance for `fino run`.
 * @internal
 */
export function createRunCommand(): Command {
  return new Command({
    name: 'run',
    description: 'Run a script module',
    options: [
      {
        flags: '--otlp-endpoint',
        type: 'string',
        description: 'Enable OpenTelemetry export to the given OTLP/HTTP collector endpoint',
      },
      {
        flags: '--watch',
        type: 'boolean',
        description: 'Re-run the script whenever any imported file changes',
      },
    ],
    run: runScriptCommand,
    positionals: [
      { name: 'script', type: 'string', required: true, description: 'Script module to execute' },
    ],
  });
}
