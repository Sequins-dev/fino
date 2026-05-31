import { Command } from '../util/argv.mts';
import { cwd, env } from '../runtime/process.mts';
import { createTestCommand } from './test.mts';
import { createBenchCommand } from './bench.mts';
import { createInstallCommand } from './install.mts';
import { createInitCommand } from './init.mts';
import { createDocCommand } from './doc.mts';
import { createReplCommand } from './repl.mts';
import {
  LoggerProvider,
  MeterProvider,
  TracerProvider,
  runWithLoggerProvider,
  runWithMeterProvider,
  runWithTracerProvider,
} from '../opentelemetry.mts';
import { createCliOtelRuntime } from '../opentelemetry/bootstrap.mts';
import { Realm } from '../runtime/realm.mts';

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

export function createRootCommand(): Command {
  return new Command({
    name: 'fino',
    description: 'Fino runtime CLI',
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
    run: async function runRootCommand(ctx) {
      const script = ctx.args.script;
      if (script === undefined) return ctx.command.help();
      const watchMode = ctx.options['watch'] === true;
      if (watchMode) {
        const entry = normalizeScriptSpecifier(String(script));
        const realm = new Realm({ entry, watch: true });
        // Let SIGINT / Ctrl-C terminate the watch loop cleanly.
        (globalThis as Record<string, unknown>).addEventListener?.('beforeunload', () => realm.terminate());
        return realm.run();
      }
      const load = () => import(normalizeScriptSpecifier(String(script)));
      const endpoint = typeof ctx.options['otlp-endpoint'] === 'string' ? ctx.options['otlp-endpoint'].trim() : '';
      if (!endpoint) return load();
      return runWithProviders(
        await createCliOtelRuntime(endpoint, String(script), env.FINO_OTEL_DEBUG === '1'),
        load,
      );
    },
    positionals: [
      { name: 'script', type: 'string', description: 'Script module to execute' },
    ],
    commands: [
      createTestCommand(),
      createBenchCommand(),
      createInstallCommand(),
      createInitCommand(),
      createDocCommand(),
      createReplCommand(),
    ],
  });
}
