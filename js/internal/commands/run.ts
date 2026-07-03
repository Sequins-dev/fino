/**
* internal/commands/run — internal runtime module.
*
* Implements script execution for both `fino run <script>` and the root
* shortcut `fino <script>`. The module handles path normalization and hands
* the script to the orchestrator (`internal:orchestrator`), which runs it as
* a supervised app-workload child realm. With `--otlp-endpoint` or
* `OTEL_EXPORTER_OTLP_ENDPOINT`, the endpoint travels to the child via
* `RealmOptions.data.cliOtel` so the child installs its own CLI OpenTelemetry
* providers around the entry import. Watch mode keeps its own realm path.
*
* ```js
* import { createRunCommand } from 'internal:commands/run';
* const command = createRunCommand();
* console.log(command.name);
* ```
*
* @internal
*/
import { Task } from '../../task.ts';
import { cwd, env } from '../../process.ts';
import { Realm } from '../../realm/index.ts';
import { runApp } from '../orchestrator/index.ts';
function fileUrlFromPath(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let encoded = '';
  for (const byte of bytes) {
    if (byte === 47 || byte >= 48 && byte <= 57 || byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte === 45 || byte === 46 || byte === 95 || byte === 126) {
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
interface RunInput {
  script?: unknown;
  watch?: unknown;
  'otlp-endpoint'?: unknown;
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
* await command.parse(['./example.ts']);
* ```
*
* @param ctx Parsed command context from `process/argv`.
* @returns The imported module result, realm run result, or help text.
* @internal
*/
export async function runScriptTask(input: RunInput): Promise<unknown> {
  const script = input.script;
  if (script === undefined) throw new Error('fino run: no script specified');
  const watchMode = input.watch === true;
  if (watchMode) {
    const entry = normalizeScriptSpecifier(String(script));
    const realm = new Realm({
      entry,
      watch: true
    });
    // Let SIGINT / Ctrl-C terminate the watch loop cleanly.
    (globalThis as Record<string, unknown>).addEventListener?.('beforeunload', () => realm.terminate());
    return realm.run();
  }
  const entry = normalizeScriptSpecifier(String(script));
  if (String(env.OTEL_SDK_DISABLED || '').trim().toLowerCase() === 'true') return runApp({ entry });
  const endpointOption = input['otlp-endpoint'];
  const flagEndpoint = typeof endpointOption === 'string' ? endpointOption.trim() : '';
  const envEndpoint = typeof env.OTEL_EXPORTER_OTLP_ENDPOINT === 'string' ? env.OTEL_EXPORTER_OTLP_ENDPOINT.trim() : '';
  const endpoint = flagEndpoint || envEndpoint;
  if (!endpoint) return runApp({ entry });
  return runApp({
    entry,
    data: {
      cliOtel: {
        endpoint,
        script: String(script),
        debug: env.FINO_OTEL_DEBUG === '1'
      }
    }
  });
}
/**
* Create the explicit `run` subcommand.
*
* The command requires a script positional and supports `--watch` plus
* `--otlp-endpoint`. Its runtime behavior is delegated to
* `runScriptTask()`, so root-level and subcommand script execution stay
* consistent.
*
* ```js
* import { createRunCommand } from 'internal:commands/run';
* const run = createRunCommand();
* await run.parse(['--watch', 'server.ts']);
* ```
*
* @returns A configured `Task` instance for `fino run`.
* @internal
*/
export function createRunCommand(): Task {
  return new Task({
    name: 'run',
    description: 'Run a script module',
    outputMode: 'text',
    cli: {
      options: [{
        flags: '--otlp-endpoint',
        type: 'string',
        description: 'Enable OpenTelemetry export to the given OTLP/HTTP collector endpoint'
      }, {
        flags: '--watch',
        type: 'boolean',
        description: 'Re-run the script whenever any imported file changes'
      }],
      positionals: [{
        name: 'script',
        type: 'string',
        required: true,
        description: 'Script module to execute'
      }]
    },
    run: runScriptTask
  });
}
