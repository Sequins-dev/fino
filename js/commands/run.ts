/**
* fino:commands/run — reusable `fino run` command task.
*
* Implements script execution for both `fino run <script>` and the root
* shortcut `fino <script>` — the root command delegates here, so both paths
* behave identically. The script positional is normalized to a `file://` URL
* (relative paths resolve against the current working directory; specifiers
* that already carry a scheme pass through unchanged) and handed to the
* orchestrator (`internal:orchestrator`), which runs it as a supervised
* app-workload child realm.
*
* With `--otlp-endpoint` or the `OTEL_EXPORTER_OTLP_ENDPOINT` environment
* variable, the endpoint travels to the child as realm bootstrap metadata so
* the child installs its own CLI OpenTelemetry providers around the entry
* import. With `--watch`, the script instead runs in a watched `Realm` that
* re-runs whenever an imported file changes, using the same metadata path.
*
* ```ts no_run
* import runCommand from 'fino:commands/run';
*
* // Equivalent to `fino run ./server.ts` on the command line.
* await runCommand.parse(['./server.ts']);
* ```
*/
import { Task } from '../task.ts';
import { cwd, env } from '../process.ts';
import { Realm } from '../realm/index.ts';
import { runApp } from '../internal/orchestrator/index.ts';
/**
* Percent-encode an absolute filesystem path into a `file://` URL.
*
* Encodes the path's UTF-8 bytes, leaving `/` and URL-safe unreserved
* characters intact so the loader receives a valid URL even for paths with
* spaces or non-ASCII segments.
*/
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
/**
* Resolve the script positional to a module specifier the loader accepts.
*
* `file://` URLs and specifiers containing a scheme (anything with a `:`,
* such as `fino:repl`) pass through unchanged. Absolute paths become
* `file://` URLs directly; relative paths — with or without a leading `./` —
* resolve against the current working directory first.
*/
function normalizeScriptSpecifier(script: string): string {
  if (script.startsWith('file://')) return script;
  if (script.startsWith('/')) return fileUrlFromPath(script);
  if (script.startsWith('./') || script.startsWith('../')) return fileUrlFromPath(`${cwd()}/${script}`);
  if (script.includes(':')) return script;
  return fileUrlFromPath(`${cwd()}/./${script}`);
}
/**
* Parsed CLI input consumed by the run task.
*
* Fields arrive untyped from the generic task input, so each is validated at
* the point of use rather than trusted from the parser.
*/
interface RunInput {
  script?: unknown;
  watch?: unknown;
  'otlp-endpoint'?: unknown;
}
/**
* Determine the OTLP endpoint for this run, if telemetry should bootstrap.
*
* The `--otlp-endpoint` flag wins over the `OTEL_EXPORTER_OTLP_ENDPOINT`
* environment variable, blank values are ignored, and `OTEL_SDK_DISABLED=true`
* suppresses both sources.
*/
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
* Throws if no script positional is present. With `--watch`, the script runs
* inside a watched `Realm`, which is terminated on `beforeunload` so
* Ctrl-C exits the watch loop cleanly. With an `--otlp-endpoint` option or
* `OTEL_EXPORTER_OTLP_ENDPOINT`, the script import runs with CLI OpenTelemetry
* providers installed; otherwise it is imported directly. Constructed child
* realms inherit the endpoint unless they override `RealmOptions.otlpEndpoint`
* or set it to `false`. The CLI flag wins over the environment endpoint, and
* `OTEL_SDK_DISABLED=true` disables env and flag bootstrap. Import failures
* and provider bootstrap errors propagate to the caller.
*
* ```ts no_run
* import runCommand from 'fino:commands/run';
*
* await runCommand.run({ script: './example.ts' });
* ```
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
* The `run` command task, exported as the module default.
*
* The command requires a script positional and supports `--watch` plus
* `--otlp-endpoint`. Option parsing stops after the script positional, so any
* later tokens — flags included — are collected as `args` for the script
* rather than parsed as run options. Runtime behavior is delegated to the
* same private script runner the root shortcut uses, so root-level and
* subcommand script execution stay consistent.
*
* ```ts no_run
* import run from 'fino:commands/run';
*
* // `fino run --watch server.ts --port 8080` — the trailing flag
* // belongs to server.ts, not to the run command.
* await run.parse(['--watch', 'server.ts', '--port', '8080']);
* ```
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
