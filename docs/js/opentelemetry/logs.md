# js/opentelemetry/logs

fino:opentelemetry/logs - logger providers, loggers, severities, and log records.

This module contains the public log signal API. Use it to emit structured log
records, build records incrementally, override logger providers for scoped
execution, and describe logs consumed by SDK processors and exporters.

The default severity is `INFO` with severity number `9`. Emitted records
capture active trace context when available. SDK processors may apply
attribute count and value length limits before export; logger emission keeps
explicit record fields intact.

```typescript
import { LogRecordBuilder, SeverityNumber, getLoggerProvider } from 'fino:opentelemetry/logs';

const logger = getLoggerProvider().getLogger('orders');
logger.emitRecord(
  new LogRecordBuilder()
    .setSeverity('WARN', SeverityNumber.WARN)
    .setTextBody('slow order path'),
);
```

See OpenTelemetry logs:
https://opentelemetry.io/docs/concepts/signals/logs/

## LogRecordBuilder

```ts
class LogRecordBuilder {
```

LogRecordBuilder class exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const ctor = LogRecordBuilder;
```

### constructor

```ts
constructor()
```

constructor member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new LogRecordBuilder();
```

### setBody

```ts
setBody(body: unknown): this
```

setBody member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setBody;
```

### setTextBody

```ts
setTextBody(body: string): this
```

setTextBody member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setTextBody;
```

### setJsonBody

```ts
setJsonBody(body: unknown): this
```

setJsonBody member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setJsonBody;
```

### setSeverity

```ts
setSeverity(severityText: string, severityNumber?: number): this
```

setSeverity member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setSeverity;
```

### setAttribute

```ts
setAttribute(key: string, value: unknown): this
```

setAttribute member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setAttribute;
```

### setAttributes

```ts
setAttributes(attributes: Attributes): this
```

setAttributes member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setAttributes;
```

### setEventName

```ts
setEventName(name: string): this
```

setEventName member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setEventName;
```

### setCategory

```ts
setCategory(name: string): this
```

setCategory member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setCategory;
```

### setDroppedAttributesCount

```ts
setDroppedAttributesCount(count: number): this
```

setDroppedAttributesCount member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setDroppedAttributesCount;
```

### setContext

```ts
setContext(context: TraceContext | null | undefined): this
```

setContext member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setContext;
```

### build

```ts
build(): LogRecord
```

build member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.build;
```

## Logger

```ts
class Logger {
```

Logger class exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const ctor = Logger;
```

### constructor

```ts
constructor(provider: LoggerProvider, scope: ScopeInfo)
```

constructor member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new Logger();
```

### scope

```ts
get scope(): ScopeInfo
```

scope member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const getter = Logger.prototype.scope;
```

### emit

```ts
emit(body: unknown, options: {
  severityText?: string;
  severityNumber?: number;
  attributes?: Attributes;
} = {}): void
```

emit member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Logger.prototype.emit;
```

### emitRecord

```ts
emitRecord(builder: LogRecordBuilder | Partial<LogRecord>): void
```

emitRecord member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Logger.prototype.emitRecord;
```

### debug

```ts
debug(body: unknown, attributes: Attributes = {}): void
```

debug member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Logger.prototype.debug;
```

### info

```ts
info(body: unknown, attributes: Attributes = {}): void
```

info member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Logger.prototype.info;
```

### warn

```ts
warn(body: unknown, attributes: Attributes = {}): void
```

warn member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Logger.prototype.warn;
```

### error

```ts
error(body: unknown, attributes: Attributes = {}): void
```

error member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Logger.prototype.error;
```

## LoggerProvider

```ts
class LoggerProvider extends BaseProvider {
```

LoggerProvider class exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const ctor = LoggerProvider;
```

### getLogger

```ts
getLogger(name: string, version?: string, options?: {
  schemaUrl?: string | null;
  attributes?: Attributes;
  droppedAttributesCount?: number;
}): Logger
```

getLogger member on LoggerProvider.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LoggerProvider.prototype.getLogger;
```

## SeverityNumber

```ts
enum SeverityNumber {
  TRACE = 1,
  TRACE2 = 2,
  TRACE3 = 3,
  TRACE4 = 4,
  DEBUG = 5,
  DEBUG2 = 6,
  DEBUG3 = 7,
  DEBUG4 = 8,
  INFO = 9,
  INFO2 = 10,
  INFO3 = 11,
  INFO4 = 12,
  WARN = 13,
  WARN2 = 14,
  WARN3 = 15,
  WARN4 = 16,
  ERROR = 17,
  ERROR2 = 18,
  ERROR3 = 19,
  ERROR4 = 20,
  FATAL = 21,
  FATAL2 = 22,
  FATAL3 = 23,
  FATAL4 = 24
}

```

SeverityNumber enum exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const value = SeverityNumber;
```

## applyLogLimits

```ts
function applyLogLimits(log: LogRecord, limits: {
  attributeCountLimit?: number;
  attributeValueLengthLimit?: number;
} = {}): LogRecord
```

applyLogLimits function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = applyLogLimits;
```

## getLoggerProvider

```ts
function getLoggerProvider(): LoggerProvider
```

getLoggerProvider function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = getLoggerProvider;
```

## runWithLoggerProvider

```ts
function runWithLoggerProvider<R>(provider: LoggerProvider, fn: () => R): R
```

runWithLoggerProvider function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = runWithLoggerProvider;
```

## runWithoutLoggerProvider

```ts
function runWithoutLoggerProvider<R>(fn: () => R): R
```

runWithoutLoggerProvider function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = runWithoutLoggerProvider;
```

## setLoggerProvider

```ts
function setLoggerProvider(provider: LoggerProvider): void
```

setLoggerProvider function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = setLoggerProvider;
```

## LogRecord

```ts
interface LogRecord {
```

LogRecord interface exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const value: LogRecord = {} as LogRecord;
```

### schemaVersion

```ts
schemaVersion?: number
```

schemaVersion property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['schemaVersion'];
```

### body

```ts
body?: unknown
```

body property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['body'];
```

### severityText

```ts
severityText?: string
```

severityText property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['severityText'];
```

### severityNumber

```ts
severityNumber?: number
```

severityNumber property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['severityNumber'];
```

### timeUnixNano

```ts
timeUnixNano?: number
```

timeUnixNano property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['timeUnixNano'];
```

### observedTimeUnixNano

```ts
observedTimeUnixNano?: number
```

observedTimeUnixNano property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['observedTimeUnixNano'];
```

### attributes

```ts
attributes?: Attributes
```

attributes property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['attributes'];
```

### droppedAttributesCount

```ts
droppedAttributesCount?: number
```

droppedAttributesCount property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['droppedAttributesCount'];
```

### scope

```ts
scope?: ScopeInfo
```

scope property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['scope'];
```

### resource

```ts
resource?: Resource
```

resource property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['resource'];
```

### traceId

```ts
traceId?: string
```

traceId property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['traceId'];
```

### spanId

```ts
spanId?: string
```

spanId property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['spanId'];
```

### traceFlags

```ts
traceFlags?: number
```

traceFlags property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['traceFlags'];
```

### baggage

```ts
baggage?: Baggage | null
```

baggage property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['baggage'];
```

### eventName

```ts
eventName?: string
```

eventName property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['eventName'];
```

### categoryName

```ts
categoryName?: string
```

categoryName property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['categoryName'];
```

### flags

```ts
flags?: number
```

flags property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: LogRecord['flags'];
```
