/**
* fino:commands/run — reusable `fino run` command task.
*
* Implements script execution for both `fino run <script>` and the root
* shortcut `fino <script>`. The module handles path normalization and hands
* the script to the orchestrator (`internal:orchestrator`), which runs it as
* a supervised app-workload child realm. With `--otlp-endpoint` or
* `OTEL_EXPORTER_OTLP_ENDPOINT`, the endpoint travels to the child as realm
* bootstrap metadata so the child installs its own CLI OpenTelemetry providers
* around the entry import. Watch mode uses the same metadata path.
*
* ```js
* import runCommand from 'fino:commands/run';
* const command = runCommand;
* console.log(command.name);
* ```
*
*/
import { Task } from '../task.ts';
import { cwd, env } from '../process.ts';
import { Realm } from '../realm/index.ts';
import { runApp } from '../internal/orchestrator/index.ts';
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
function cliOtlpEndpoint(input: RunInput): string | undefined {
  if (String(env.OTEL_SDK_DISABLED || '').trim().toLowerCase() === 'true') return undefined;
  const endpointOption = input['otlp-endpoint'];
  const flagEndpoint = typeof endpointOption === 'string' ? endpointOption.trim() : '';
  const envEndpoint = typeof env.OTEL_EXPORTER_OTLP_ENDPOINT === 'string' ? env.OTEL_EXPORTER_OTLP_ENDPOINT.trim() : '';
  return flagEndpoint || envEndpoint || undefined;
}
/**
* Execute the script referenced by a parsed command context.
*
* When no script positional is present, this returns the command help output.
* With `--watch`, the script runs inside a watched `Realm` and the realm is
* terminated on `beforeunload`. With an `--otlp-endpoint` option or
* `OTEL_EXPORTER_OTLP_ENDPOINT`, the script import runs with CLI OpenTelemetry
* providers installed; otherwise it is imported directly. Constructed child
* realms inherit the endpoint unless they override `RealmOptions.otlpEndpoint`
* or set it to `false`. The CLI flag wins over the environment endpoint, and
* `OTEL_SDK_DISABLED=true` disables env and flag bootstrap. Import failures
* and provider bootstrap errors propagate to the caller.
*
* ```js
* import runCommand from 'fino:commands/run';
* const command = runCommand;
* await command.parse(['./example.ts']);
* ```
*
*/
async function runScriptTask(input: RunInput): Promise<unknown> {
  const script = input.script;
  if (script === undefined) throw new Error('fino run: no script specified');
  const watchMode = input.watch === true;
  if (watchMode) {
    const entry = normalizeScriptSpecifier(String(script));
    const endpoint = cliOtlpEndpoint(input);
    const realm = new Realm({
      entry,
      watch: true,
      ...endpoint !== undefined ? { otlpEndpoint: endpoint } : {}
    });
    // Let SIGINT / Ctrl-C terminate the watch loop cleanly.
    (globalThis as Record<string, unknown>).addEventListener?.('beforeunload', () => realm.terminate());
    return realm.run();
  }
  const entry = normalizeScriptSpecifier(String(script));
  const endpoint = cliOtlpEndpoint(input);
  if (!endpoint) return runApp({ entry });
  return runApp({
    entry,
    otlpEndpoint: endpoint
  });
}
/**
* Create the explicit `run` subcommand.
*
* The command requires a script positional and supports `--watch` plus
* `--otlp-endpoint`. Its runtime behavior is delegated to
* the same private script runner as the root shortcut, so root-level and
* subcommand script execution stay consistent.
*
* ```js
* import run from 'fino:commands/run';
* await run.parse(['--watch', 'server.ts']);
* ```
*
*/
const command = new Task({
    name: 'run',
    description: 'Run a script module',
    outputMode: 'text',
    cli: {
      stopOptionsAfterPositionals: true,
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
      }, {
        name: 'args',
        type: 'string',
        multiple: true,
        description: 'Arguments passed to the script'
      }]
    },
    run: runScriptTask
});
export { command as default };
