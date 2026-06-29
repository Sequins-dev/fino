/**
* fino:opentelemetry/logs - logger providers, loggers, severities, and log records.
*
* This module contains the public log signal API. Use it to emit structured log
* records, build records incrementally, override logger providers for scoped
* execution, and describe logs consumed by SDK processors and exporters.
*
* The default severity is `INFO` with severity number `9`. Emitted records
* capture active trace context when available. SDK processors may apply
* attribute count and value length limits before export; logger emission keeps
* explicit record fields intact.
*
* ```typescript no_run
* import { LogRecordBuilder, SeverityNumber, getLoggerProvider } from 'fino:opentelemetry/logs';
*
* const logger = getLoggerProvider().getLogger('orders');
* logger.emitRecord(
*   new LogRecordBuilder()
*     .setSeverity('WARN', SeverityNumber.WARN)
*     .setTextBody('slow order path'),
* );
* ```
*
* See OpenTelemetry logs:
* https://opentelemetry.io/docs/concepts/signals/logs/
*/
export { LogRecordBuilder, Logger, LoggerProvider, SeverityNumber, applyLogLimits, getLoggerProvider, runWithLoggerProvider, runWithoutLoggerProvider, setLoggerProvider } from '../internal/opentelemetry/logs.ts';
export type { LogRecord } from '../internal/opentelemetry/common.ts';
