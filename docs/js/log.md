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

### timestamp

```ts
timestamp: string
```

ISO-8601 timestamp generated when the record is emitted.

### level

```ts
level: LogLevel
```

Normalized severity level.

### logger

```ts
logger: string
```

Logger name, usually a dotted subsystem path.

### message

```ts
message: string
```

Human-readable event message.

### fields

```ts
fields: Fields
```

Per-call structured fields.

### context

```ts
context: Fields
```

Async-scoped and logger-scoped fields merged together.

### error

```ts
error?: { name: string; message: string; stack?: string; }
```

Normalized error details when the message or `fields.error` is an Error.

### traceId

```ts
traceId?: string
```

OpenTelemetry trace id copied from the active span, when present.

### spanId

```ts
spanId?: string
```

OpenTelemetry span id copied from the active span, when present.

### traceFlags

```ts
traceFlags?: number
```

OpenTelemetry trace flags copied from the active span, when present.

## LoggerOptions

```ts
interface LoggerOptions {
```

Options for constructing a `Logger`.

### name

```ts
name: string
```

Non-empty logger name.

### level

```ts
level?: LogLevel
```

Minimum emitted level. Defaults to `trace`.

### context

```ts
context?: Fields
```

Fields attached to every record emitted by this logger.

## SinkOptions

```ts
interface SinkOptions {
```

Shared options for log subscriptions and sinks.

### level

```ts
level?: LogLevel
```

Minimum level accepted by the subscription. Defaults to all levels.

## WriteSinkOptions

```ts
interface WriteSinkOptions extends SinkOptions {
```

Options for line-oriented sinks such as text and JSON output.

### write

```ts
write?: (line: string, record: LogRecord) => void
```

Receives each rendered line. Defaults to direct stdout/stderr writes.

## getLogContext

```ts
function getLogContext(): Fields
```

Return the current async-scoped log context.

The returned object is a shallow copy, so mutating it does not alter the
active context.

## runWithLogContext

```ts
function runWithLogContext<R>(context: Fields, fn: () => R): R
```

Run `fn` with additional structured log context.

The provided fields are shallow-merged over any existing context and are
visible to logger calls made through async continuations created inside
`fn`.

## Logger

```ts
class Logger {
```

Emits structured log records onto the fino log topics.

### constructor

```ts
constructor(options: LoggerOptions)
```

Create a logger with a required non-empty name.

### name

```ts
get name(): string
```

Logger name included on every emitted record.

### level

```ts
get level(): LogLevel
```

Minimum level this logger emits.

### child

```ts
child(options: Fields | (Partial<LoggerOptions> & { name?: string }) = {}): Logger
```

Create a child logger.

If `options.name` is provided, it is appended to the parent name with a
dot. Other fields become logger context unless provided under
`options.context`.

### log

```ts
log(level: LogLevel, message: unknown, fields: Fields = {}): void
```

Emit a record at an arbitrary level.

Prefer the level-specific helpers for normal use. Passing an `Error` as
`message`, or as `fields.error`, attaches normalized error details.

### trace

```ts
trace(message: unknown, fields: Fields = {}): void
```

Emit a trace-level record.

### debug

```ts
debug(message: unknown, fields: Fields = {}): void
```

Emit a debug-level record.

### info

```ts
info(message: unknown, fields: Fields = {}): void
```

Emit an info-level record.

### warn

```ts
warn(message: unknown, fields: Fields = {}): void
```

Emit a warn-level record.

### error

```ts
error(message: unknown, fields: Fields = {}): void
```

Emit an error-level record.

### fatal

```ts
fatal(message: unknown, fields: Fields = {}): void
```

Emit a fatal-level record.

## createLogger

```ts
function createLogger(options: LoggerOptions): Logger
```

Convenience factory for `new Logger(options)`.

## subscribeLogs

```ts
function subscribeLogs(fn: (record: LogRecord) => void, options: SinkOptions = {})
```

Subscribe to structured log records.

Returns a disposable subscription handle. This is the lowest-level sink API;
higher-level sinks are thin wrappers over this function.

## createJsonSink

```ts
function createJsonSink(options: WriteSinkOptions = {})
```

Subscribe a JSON-lines sink.

Without a custom `write`, records are written directly to stdout/stderr with
one JSON object per line. The sink is opt-in; importing `fino:log` never
installs it automatically.

## createConsoleSink

```ts
function createConsoleSink(options: WriteSinkOptions = {})
```

Subscribe a human-readable console sink.

This is intended for local development. Production ingestion should normally
use `createJsonSink()` or `createOtelSink()`.

## createOtelSink

```ts
function createOtelSink(options: SinkOptions = {})
```

Subscribe an OpenTelemetry sink.

Records are forwarded through the active/default OTel `LoggerProvider`.
Context and fields become log attributes, and normalized errors become
`exception.*` attributes.
