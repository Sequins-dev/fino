/** CLI OpenTelemetry integration tests. */
import { describe, it } from 'fino:test/test';
import { expectLiveOtelSignal, runCli } from './cli-test-helpers.ts';

describe('CLI commands: otel', () => {
  it('boots OTEL export for the root script and its dependencies', async (t) => {
    const { stdout, stderr, result } = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-script.ts',
    ]);
    t.equal(result.code, 0, 'script exits successfully with OTEL enabled');
    t.equal(stderr, '', 'OTEL bootstrap does not write stderr');
    t.ok(stdout.includes('entry providers ready'), 'entry script sees OTEL providers');
    t.ok(stdout.includes('dependency providers ready'), 'dependency import sees OTEL providers');
    t.ok(
      stdout.includes('http://collector.example:4318/custom/v1/traces'),
      'trace export targets the configured endpoint',
    );
    t.ok(
      stdout.includes('http://collector.example:4318/custom/v1/logs'),
      'log export targets the configured endpoint',
    );
    t.ok(
      stdout.includes('http://collector.example:4318/custom/v1/metrics'),
      'metric export targets the configured endpoint',
    );
    t.ok(stdout.includes('application/json'), 'OTEL bootstrap uses JSON content type');
    t.ok(stdout.includes('"resourceSpans"'), 'trace export uses OTLP JSON structure');
    t.ok(stdout.includes('"resourceLogs"'), 'log export uses OTLP JSON structure');
    t.ok(stdout.includes('"resourceMetrics"'), 'metric export uses OTLP JSON structure');
  });
  it('uses --otlp-endpoint to bootstrap the entrypoint SDK', async (t) => {
    const disabled = await runCli(['./tests/fixtures/cli-otel-entrypoint.ts']);
    t.equal(
      disabled.result.code,
      0,
      'entrypoint fixture exits successfully without OTEL bootstrap',
    );
    t.equal(disabled.stderr, '', 'entrypoint fixture without OTEL bootstrap does not write stderr');
    t.ok(
      !disabled.stdout.includes('export:http://collector.example:4318/custom/v1/traces'),
      'trace export is not active without --otlp-endpoint',
    );
    t.ok(
      !disabled.stdout.includes('export:http://collector.example:4318/custom/v1/logs'),
      'log export is not active without --otlp-endpoint',
    );
    t.ok(
      !disabled.stdout.includes('export:http://collector.example:4318/custom/v1/metrics'),
      'metric export is not active without --otlp-endpoint',
    );
    const enabled = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-entrypoint.ts',
    ]);
    t.equal(enabled.result.code, 0, 'entrypoint fixture exits successfully with OTEL bootstrap');
    t.equal(enabled.stderr, '', 'entrypoint fixture with OTEL bootstrap does not write stderr');
    t.ok(
      enabled.stdout.includes('export:http://collector.example:4318/custom/v1/traces'),
      'trace export is active with --otlp-endpoint',
    );
    t.ok(
      enabled.stdout.includes('export:http://collector.example:4318/custom/v1/logs'),
      'log export is active with --otlp-endpoint',
    );
    t.ok(
      enabled.stdout.includes('export:http://collector.example:4318/custom/v1/metrics'),
      'metric export is active with --otlp-endpoint',
    );
    t.ok(
      enabled.stdout.includes('"service.name"'),
      'entrypoint export includes service.name resource metadata',
    );
    t.ok(enabled.stdout.includes('"fino"'), 'entrypoint export uses package.json service.name');
    t.ok(
      enabled.stdout.includes('"service.version"'),
      'entrypoint export includes package version resource metadata',
    );
    t.ok(enabled.stdout.includes('"1.0.0"'), 'entrypoint export includes package.json version');
    t.ok(
      enabled.stdout.includes('"telemetry.sdk.name"'),
      'entrypoint export includes telemetry SDK metadata',
    );
    t.ok(
      !enabled.stdout.includes('POST http://collector.example:4318/custom/v1/traces'),
      'exporter requests do not generate fetch client spans',
    );
    t.ok(
      !enabled.stdout.includes('"scope":{"name":"fetch"}'),
      'exporter requests do not emit fetch scope spans',
    );
    t.ok(
      !enabled.stdout.includes('"scope":{"name":"dns"}'),
      'exporter requests do not emit dns scope spans',
    );
    t.ok(
      !enabled.stdout.includes('"scope":{"name":"socket"}'),
      'exporter requests do not emit socket scope spans',
    );
  });
  it('passes the CLI OTLP endpoint to constructed realms with overrides', async (t) => {
    const { stdout, stderr, result } = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-child-realms.ts',
    ]);
    t.equal(result.code, 0, 'child realm fixture exits successfully');
    t.equal(stderr, '', 'child realm fixture does not write stderr');
    t.ok(
      stdout.includes('export:http://collector.example:4318/custom/v1/traces'),
      'child realm inherits the CLI endpoint',
    );
    t.ok(
      stdout.includes('export:http://override-collector.example:4318/override/v1/traces'),
      'child realm can override the endpoint',
    );
    t.ok(stdout.includes('child:disabled:done'), 'disabled child still runs');
    const disabledStart = stdout.indexOf('child:override:done');
    const disabledOutput = disabledStart >= 0 ? stdout.slice(disabledStart) : stdout;
    t.ok(
      !disabledOutput.includes('export:http://collector.example:4318/custom/v1/traces'),
      'disabled child does not export to inherited endpoint',
    );
    t.ok(
      !disabledOutput.includes('export:http://override-collector.example:4318/override/v1/traces'),
      'disabled child does not export to override endpoint',
    );
  });
  it('lets --otlp-endpoint override the OTEL base endpoint env var', async (t) => {
    const flagWins = await runCli(
      [
        '--otlp-endpoint',
        'http://flag-collector.example:4318/flag',
        './tests/fixtures/cli-otel-entrypoint.ts',
      ],
      { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://env-collector.example:4318/env' } },
    );
    t.equal(flagWins.result.code, 0, 'flag-over-env entrypoint exits successfully');
    t.ok(
      flagWins.stdout.includes('export:http://flag-collector.example:4318/flag/v1/traces'),
      'flag endpoint wins for trace export',
    );
    t.ok(
      !flagWins.stdout.includes('env-collector.example'),
      'env base endpoint is not used when flag is present',
    );
  });
  it('applies OTEL per-signal endpoints, headers, compression, and resource env vars', async (t) => {
    const { stdout, stderr, result } = await runCli(['./tests/fixtures/cli-otel-entrypoint.ts'], {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://env-collector.example:4318/base',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://env-collector.example:4318/custom-traces',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://env-collector.example:4318/custom-logs',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://env-collector.example:4318/custom-metrics',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-env=one,x-other=two',
        OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
        OTEL_RESOURCE_ATTRIBUTES:
          'service.name=resource-service,deployment.environment=test,team=runtime',
        OTEL_SERVICE_NAME: 'env-service',
      },
    });
    t.equal(result.code, 0, 'env-rich entrypoint exits successfully');
    t.equal(stderr, '', 'env-rich bootstrap does not write stderr');
    t.ok(
      stdout.includes('export:http://env-collector.example:4318/custom-traces'),
      'trace endpoint override used',
    );
    t.ok(
      stdout.includes('export:http://env-collector.example:4318/custom-logs'),
      'log endpoint override used',
    );
    t.ok(
      stdout.includes('export:http://env-collector.example:4318/custom-metrics'),
      'metric endpoint override used',
    );
    t.ok(stdout.includes('"service.name"'), 'resource includes service.name');
    t.ok(stdout.includes('"env-service"'), 'OTEL_SERVICE_NAME overrides resource service.name');
    t.ok(
      stdout.includes('"deployment.environment"'),
      'resource attributes include deployment environment',
    );
    t.ok(stdout.includes('"team"'), 'resource attributes include custom team');
    t.ok(stdout.includes('x-env'), 'OTEL exporter headers are applied');
    t.ok(stdout.includes('content-encoding'), 'OTEL compression header is applied');
    t.ok(stdout.includes('gzip'), 'gzip compression is selected');
  });
  it('respects OTEL_SDK_DISABLED for env-only bootstrap', async (t) => {
    const { stdout, stderr, result } = await runCli(['./tests/fixtures/cli-otel-entrypoint.ts'], {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://env-collector.example:4318/env',
        OTEL_SDK_DISABLED: 'true',
      },
    });
    t.equal(result.code, 0, 'disabled SDK entrypoint exits successfully');
    t.equal(stderr, '', 'disabled SDK bootstrap does not write stderr');
    t.ok(
      !stdout.includes('export:http://env-collector.example:4318/env/v1/traces'),
      'disabled SDK suppresses trace export',
    );
    t.ok(
      !stdout.includes('export:http://env-collector.example:4318/env/v1/logs'),
      'disabled SDK suppresses log export',
    );
    t.ok(
      !stdout.includes('export:http://env-collector.example:4318/env/v1/metrics'),
      'disabled SDK suppresses metric export',
    );
  });
  it('keeps OTEL providers active for async work after entrypoint import', async (t) => {
    const { stdout, stderr, result } = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-async.ts',
    ]);
    t.equal(result.code, 0, 'async OTEL script exits successfully');
    t.equal(stderr, '', 'async OTEL bootstrap does not write stderr');
    t.ok(
      stdout.includes('http://collector.example:4318/custom/v1/traces'),
      'async span export targets the configured endpoint',
    );
    t.ok(
      stdout.includes('http://collector.example:4318/custom/v1/logs'),
      'async log export targets the configured endpoint',
    );
    t.ok(
      stdout.includes('http://collector.example:4318/custom/v1/metrics'),
      'async metric export targets the configured endpoint',
    );
  });
  it('flushes trace exports while the process is still running', async (t) => {
    await expectLiveOtelSignal(t, './tests/fixtures/cli-otel-live-trace.ts', 'traces', 'trace');
  });
  it('flushes log exports while the process is still running', async (t) => {
    await expectLiveOtelSignal(t, './tests/fixtures/cli-otel-live-log.ts', 'logs', 'log');
  });
  it('flushes metric exports while the process is still running', async (t) => {
    await expectLiveOtelSignal(t, './tests/fixtures/cli-otel-live-metric.ts', 'metrics', 'metric');
  });
  it('reports OTEL exporter failures to stderr', async (t) => {
    const { stdout, stderr, result } = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-error.ts',
    ]);
    t.equal(result.code, 0, 'script still exits successfully when OTEL export fails');
    t.equal(stdout, '', 'failing collector fixture does not write stdout');
    t.ok(
      stderr.includes(
        '[otel] export to http://collector.example:4318/custom failed: collector offline',
      ),
      'collector failure is reported to stderr',
    );
  });
  it('can print OTEL request and response details through FINO_OTEL_DEBUG', async (t) => {
    const { stdout, stderr, result } = await runCli(
      [
        '--otlp-endpoint',
        'http://collector.example:4318/custom',
        './tests/fixtures/cli-otel-entrypoint.ts',
      ],
      { env: { FINO_OTEL_DEBUG: '1' } },
    );
    t.equal(result.code, 0, 'debug OTEL script exits successfully');
    t.ok(
      stdout.includes('export:http://collector.example:4318/custom/v1/traces'),
      'debug fixture still exports traces',
    );
    t.ok(
      stderr.includes('[otel] request traces POST http://collector.example:4318/custom/v1/traces'),
      'debug output includes request metadata',
    );
    t.ok(
      stderr.includes('[otel] response traces 200 http://collector.example:4318/custom/v1/traces'),
      'debug output includes response metadata',
    );
    t.ok(stderr.includes('\\"service.name\\"'), 'debug output includes the JSON request body');
    t.ok(
      stderr.includes('\\"resourceSpans\\"'),
      'debug output includes OTLP trace payload structure',
    );
  });
});
