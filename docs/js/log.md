# log

fino:log — topic-based structured logging.

This module provides the application-facing logging API for fino backend
code. Loggers publish structured `LogRecord` objects onto `fino:context/topic`
channels; output is deliberately sink-driven. Creating a logger does not
install global stdout/stderr behavior, so libraries can safely log without
surprising their host application.

The default transport topic is `"fino:log"`. Additional per-level and
per-logger topics are also published for callers that want narrower
subscriptions:

  - `fino:log`
  - `fino:log:<level>`
  - `fino:log:<logger-name>`

Context is propagated with `fino:context`, so request IDs and similar fields
survive `await` boundaries. If an OpenTelemetry span is active, trace/span
identifiers are copied onto the record and can be forwarded with
`createOtelSink()`.

```ts
import { createJsonSink, createLogger, runWithLogContext } from 'fino:log';

const sink = createJsonSink();
const log = createLogger({ name: 'api', level: 'info' });

await runWithLogContext({ requestId: 'req-1' }, async () => {
  log.info('request started', { route: '/health' });
});

sink.dispose();
```

## LogRecord

```ts
interface LogRecord {
```

Structured event emitted by `Logger` and consumed by sinks/subscribers.

Records are immutable by convention once published. Sinks receive the same
record shape regardless of whether they render JSON, text, or OpenTelemetry
log events.

```ts
import { createLogger, subscribeLogs, type LogRecord } from 'fino:log';

const events: LogRecord[] = [];
const sub = subscribeLogs((record) => events.push(record));
createLogger({ name: 'api' }).info('ready');
sub.dispose();
```

### timestamp

```ts
timestamp: string
```

ISO-8601 timestamp generated when the record is emitted.

```ts
const emittedAt = new Date(record.timestamp);
```

### level

```ts
level: LogLevel
```

Normalized severity level.

```ts
if (record.level === 'error') {
  // route to stderr
}
```

### logger

```ts
logger: string
```

Logger name, usually a dotted subsystem path.

```ts
const subsystem = record.logger;
```

### message

```ts
message: string
```

Human-readable event message.

```ts
console.log(record.message);
```

### fields

```ts
fields: Fields
```

Per-call structured fields.

```ts
const route = record.fields.route;
```

### context

```ts
context: Fields
```

Async-scoped and logger-scoped fields merged together.

```ts
const requestId = record.context.requestId;
```

### error

```ts
error?: { name: string; message: string; stack?: string; }
```

Normalized error details when the message or `fields.error` is an Error.

```ts
if (record.error) {
  console.error(record.error.message);
}
```

### traceId

```ts
traceId?: string
```

OpenTelemetry trace id copied from the active span, when present.

```ts
const traceId = record.traceId ?? 'none';
```

### spanId

```ts
spanId?: string
```

OpenTelemetry span id copied from the active span, when present.

```ts
const spanId = record.spanId ?? 'none';
```

### traceFlags

```ts
traceFlags?: number
```

OpenTelemetry trace flags copied from the active span, when present.

```ts
const sampled = (record.traceFlags ?? 0) & 1;
```

## LoggerOptions

```ts
interface LoggerOptions {
```

Options for constructing a `Logger`.

A logger name is required. The level controls which records are emitted, and
context fields are attached to every record from that logger and its
descendants.

```ts
import { Logger, type LoggerOptions } from 'fino:log';

const options: LoggerOptions = {
  name: 'api',
  level: 'info',
  context: { service: 'users' },
};
const log = new Logger(options);
```

### name

```ts
name: string
```

Non-empty logger name.

```ts
const options = { name: 'api' };
```

### level

```ts
level?: LogLevel
```

Minimum emitted level. Defaults to `trace`.

```ts
const options = { name: 'api', level: 'warn' as const };
```

### context

```ts
context?: Fields
```

Fields attached to every record emitted by this logger.

```ts
const options = { name: 'api', context: { service: 'users' } };
```

## SinkOptions

```ts
interface SinkOptions {
```

Shared options for log subscriptions and sinks.

The level threshold is applied by subscribers after records are published.
It does not change logger-level filtering.

```ts
import { subscribeLogs, type SinkOptions } from 'fino:log';

const options: SinkOptions = { level: 'warn' };
const sub = subscribeLogs(() => {}, options);
sub.dispose();
```

### level

```ts
level?: LogLevel
```

Minimum level accepted by the subscription. Defaults to all levels.

```ts
const options = { level: 'error' as const };
```

## WriteSinkOptions

```ts
interface WriteSinkOptions extends SinkOptions {
```

Options for line-oriented sinks such as text and JSON output.

Provide `write` to capture lines in tests, send them to a custom stream, or
adapt records to a host logging system.

```ts
import { createJsonSink, type WriteSinkOptions } from 'fino:log';

const lines: string[] = [];
const options: WriteSinkOptions = { write: (line) => lines.push(line) };
const sink = createJsonSink(options);
sink.dispose();
```

### write

```ts
write?: (line: string, record: LogRecord) => void
```

Receives each rendered line. Defaults to direct stdout/stderr writes.

```ts
const options = { write: (line: string) => console.log(line) };
```

## getLogContext

```ts
function getLogContext(): Fields
```

Return the current async-scoped log context.

The returned object is a shallow copy, so mutating it does not alter the
active context.

```ts
import { getLogContext, runWithLogContext } from 'fino:log';

runWithLogContext({ requestId: 'req-1' }, () => {
  getLogContext().requestId; // 'req-1'
});
```

## runWithLogContext

```ts
function runWithLogContext<R>(context: Fields, fn: () => R): R
```

Run `fn` with additional structured log context.

The provided fields are shallow-merged over any existing context and are
visible to logger calls made through async continuations created inside
`fn`.

```ts
import { createLogger, runWithLogContext } from 'fino:log';

const log = createLogger({ name: 'api' });
await runWithLogContext({ requestId: 'req-1' }, async () => {
  log.info('handled request');
});
```

## Logger

```ts
class Logger {
```

Emits structured log records onto the fino log topics.

A logger filters records by its configured level, merges logger context with
async log context, and publishes matching records to broad and narrow topics.

```ts
import { Logger, createConsoleSink } from 'fino:log';

const sink = createConsoleSink({ level: 'info' });
const log = new Logger({ name: 'api', level: 'debug' });
log.info('ready', { port: 3000 });
sink.dispose();
```

### constructor

```ts
constructor(options: LoggerOptions)
```

Create a logger with a required non-empty name.

The constructor validates the level and shallow-copies context fields so
later mutations of the options object do not affect emitted records.

```ts
import { Logger } from 'fino:log';

const log = new Logger({ name: 'api', level: 'info' });
```

### name

```ts
get name(): string
```

Logger name included on every emitted record.

```ts
import { createLogger } from 'fino:log';

createLogger({ name: 'api' }).name; // 'api'
```

### level

```ts
get level(): LogLevel
```

Minimum level this logger emits.

```ts
import { createLogger } from 'fino:log';

createLogger({ name: 'api', level: 'warn' }).level; // 'warn'
```

### child

```ts
child(options: Fields | (Partial<LoggerOptions> & { name?: string }) = {}): Logger
```

Create a child logger.

If `options.name` is provided, it is appended to the parent name with a
dot. Other fields become logger context unless provided under
`options.context`.

```ts
import { createLogger } from 'fino:log';

const root = createLogger({ name: 'api', context: { service: 'users' } });
const requests = root.child({ name: 'requests', route: '/users' });
requests.info('started');
```

### log

```ts
log(level: LogLevel, message: unknown, fields: Fields = {}): void
```

Emit a record at an arbitrary level.

Prefer the level-specific helpers for normal use. Passing an `Error` as
`message`, or as `fields.error`, attaches normalized error details.

```ts
import { createLogger } from 'fino:log';

const log = createLogger({ name: 'api' });
log.log('warn', 'slow request', { durationMs: 1200 });
```

### trace

```ts
trace(message: unknown, fields: Fields = {}): void
```

Emit a trace-level record.

```ts
createLogger({ name: 'api' }).trace('cache lookup');
```

### debug

```ts
debug(message: unknown, fields: Fields = {}): void
```

Emit a debug-level record.

```ts
createLogger({ name: 'api' }).debug('cache miss', { key: 'user:1' });
```

### info

```ts
info(message: unknown, fields: Fields = {}): void
```

Emit an info-level record.

```ts
createLogger({ name: 'api' }).info('request started');
```

### warn

```ts
warn(message: unknown, fields: Fields = {}): void
```

Emit a warn-level record.

```ts
createLogger({ name: 'api' }).warn('rate limit near capacity');
```

### error

```ts
error(message: unknown, fields: Fields = {}): void
```

Emit an error-level record.

```ts
createLogger({ name: 'api' }).error(new Error('database unavailable'));
```

### fatal

```ts
fatal(message: unknown, fields: Fields = {}): void
```

Emit a fatal-level record.

```ts
createLogger({ name: 'api' }).fatal('process cannot continue');
```

## createLogger

```ts
function createLogger(options: LoggerOptions): Logger
```

Convenience factory for `new Logger(options)`.

Use this when a factory reads more naturally than a constructor. It performs
the same validation and returns the same `Logger` class.

```ts
import { createLogger } from 'fino:log';

const log = createLogger({ name: 'api', level: 'info' });
log.info('ready');
```

## subscribeLogs

```ts
function subscribeLogs(fn: (record: LogRecord) => void, options: SinkOptions = {})
```

Subscribe to structured log records.

Returns a disposable subscription handle. This is the lowest-level sink API;
higher-level sinks are thin wrappers over this function.

```ts
import { createLogger, subscribeLogs } from 'fino:log';

const sub = subscribeLogs((record) => {
  console.log(record.level, record.message);
}, { level: 'info' });
createLogger({ name: 'api' }).info('ready');
sub.dispose();
```

## createJsonSink

```ts
function createJsonSink(options: WriteSinkOptions = {})
```

Subscribe a JSON-lines sink.

Without a custom `write`, records are written directly to stdout/stderr with
one JSON object per line. The sink is opt-in; importing `fino:log` never
installs it automatically.

```ts
import { createJsonSink, createLogger } from 'fino:log';

const sink = createJsonSink({ level: 'info' });
createLogger({ name: 'api' }).info('ready');
sink.dispose();
```

## createConsoleSink

```ts
function createConsoleSink(options: WriteSinkOptions = {})
```

Subscribe a human-readable console sink.

This is intended for local development. Production ingestion should normally
use `createJsonSink()` or `createOtelSink()`.

```ts
import { createConsoleSink, createLogger } from 'fino:log';

const sink = createConsoleSink();
createLogger({ name: 'api' }).warn('slow request');
sink.dispose();
```

## createOtelSink

```ts
function createOtelSink(options: SinkOptions = {})
```

Subscribe an OpenTelemetry sink.

Records are forwarded through the active/default OTel `LoggerProvider`.
Context and fields become log attributes, and normalized errors become
`exception.*` attributes.

```ts
import { createLogger, createOtelSink } from 'fino:log';

const sink = createOtelSink({ level: 'info' });
createLogger({ name: 'api' }).info('exported to OpenTelemetry');
sink.dispose();
```
