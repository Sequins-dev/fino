/**
 * internal/commands/run — internal runtime module.
 *
 *
 * @internal
 */

import { Command, type CommandContext } from '../../util/argv.mts';
import { cwd, env } from '../../runtime/process.mts';
import { Realm } from '../../runtime/realm/index.mts';
import {
  LoggerProvider,
  MeterProvider,
  TracerProvider,
  runWithLoggerProvider,
  runWithMeterProvider,
  runWithTracerProvider,
} from '../../opentelemetry/index.mts';
import { createCliOtelRuntime } from '../opentelemetry/bootstrap.mts';

function normalizeScriptSpecifier(script: string): string {
  if (script.startsWith('file://')) return script;
  if (script.startsWith('/')) return `file://${script}`;
  if (script.startsWith('./') || script.startsWith('../')) return `file://${cwd()}/${script}`;
  if (script.includes(':')) return script;
  return `file://${cwd()}/./${script}`;
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
  const endpointOption = optionValue(ctx, 'otlp-endpoint');
  const endpoint = typeof endpointOption === 'string' ? endpointOption.trim() : '';
  if (!endpoint) return load();
  return runWithProviders(
    await createCliOtelRuntime(endpoint, String(script), env.FINO_OTEL_DEBUG === '1'),
    load,
  );
}

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
