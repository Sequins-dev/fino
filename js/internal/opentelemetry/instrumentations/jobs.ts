/**
* internal/opentelemetry/instrumentations/jobs — background-job execution spans from `fino:jobs` lifecycle events.
*
* The `fino:jobs` service publishes runtime topic events as it dispatches each
* queued job: `jobs.job.start` when a processor begins an attempt and
* `jobs.job.end` when that attempt resolves. This instrumentation turns each
* matched start/end pair into a single OpenTelemetry span named `JOB <task>`,
* so job processing shows up in traces alongside the request or scheduler tick
* that enqueued the work.
*
* Executions are correlated by job id. A `start` event opens an entry in an
* in-flight map holding the task name, queue, attempt number, and start
* timestamp; the matching `end` event closes it and emits the span. An `end`
* with no recorded `start` (published before the instrumentation subscribed, or
* for a job whose start was dropped) is silently ignored, so the map never
* leaks half-open executions. The `end` event carries a `status` that reflects
* the outcome the service recorded — `done` for a completed attempt, `waiting`
* for a durable job that parked, and `failed` for an attempt that errored;
* only `failed` produces an `ERROR` span status, everything else is `OK`.
*
* Spans are recorded through {@link createRuntimeClientSpan}, so a job that runs
* inside an active trace nests under it and one dispatched by background
* machinery becomes a root. Events are only turned into spans while tracer
* context recording is enabled, so no work is done when tracing is off.
*
* This module is internal to the OpenTelemetry implementation and is wired up by
* the instrumentation registry; application code enables it by configuring the
* SDK rather than importing it directly.
*
* ```ts no_run
* import { JobsInstrumentation } from 'internal:opentelemetry/instrumentations/jobs';
* import { getSpanProcessor } from 'internal:opentelemetry/traces.ts';
*
* const instrumentation = new JobsInstrumentation();
* const handle = instrumentation.enable({
*   recordSpan(span) { getSpanProcessor()?.onEnd(span); },
* });
*
* // ... application runs; jobs are dispatched and traced ...
*
* handle.dispose();
* ```
*
* @internal
*/
import { topic } from '../../../context/topic.ts';
import { nowUnixNano, otelRuntimeTopic } from '../common.ts';
import type { Disposable, OtelSdkLike } from '../common.ts';
import { createRuntimeClientSpan } from './_runtime-client.ts';
import { isTracerProviderContextEnabled } from '../traces.ts';

/**
* Shape of the `jobs.job.start` and `jobs.job.end` runtime topic payloads.
*
* Emitted by the `fino:jobs` service around each dispatch attempt. The start
* event carries the identifying fields (`jobId`, `task`, `queue`, `attempt`);
* the end event repeats them and adds `durationMs` and `status`. Every field is
* optional because the instrumentation treats the payload defensively — only
* `jobId` is required to correlate, and a `task` is used purely for the span
* name. `resource` is typed as `never`: job events never carry a resource, so
* the span factory always receives `undefined` for it.
*
* @internal
*/
interface JobsRuntimeEvent {
  jobId?: string;
  task?: string;
  queue?: string;
  attempt?: number;
  status?: string;
  durationMs?: number;
  timeUnixNano?: number;
  resource?: never;
}

/**
* Instrumentation that records one span per background-job execution attempt.
*
* Subscribing with {@link enable} attaches listeners to the `jobs.job.start`
* and `jobs.job.end` topics. Each start is buffered by job id and each matching
* end flushes a `JOB <task>` client span into the supplied SDK sink, carrying
* `job.id`, `job.task`, `job.queue`, `job.attempt`, and `job.outcome`
* attributes when those fields are present. A `failed` outcome sets an `ERROR`
* span status with an explanatory message; all other outcomes are `OK`.
*
* Only start/end pairs observed while tracer context recording is enabled
* produce spans, and an end without a buffered start is ignored, so the
* internal map cannot accumulate stale entries. A single instance can serve one
* SDK sink at a time — call {@link enable} once and hold its disposable for the
* lifetime of the tracer provider.
*
* ```ts no_run
* import { JobsInstrumentation } from 'internal:opentelemetry/instrumentations/jobs';
*
* const collected = [];
* const handle = new JobsInstrumentation().enable({
*   recordSpan(span) { collected.push(span); },
* });
*
* // Later, when the job service and instrumentation both wind down:
* handle.dispose();
* ```
*
* @internal
*/
export class JobsInstrumentation {
  /**
  * In-flight job executions keyed by job id, buffered between start and end.
  *
  * A `jobs.job.start` populates this map with the fields needed to shape the
  * eventual span; the matching `jobs.job.end` reads and deletes the entry.
  * Entries only exist for the window between the two events, so the map size
  * tracks the number of jobs currently executing.
  *
  * @internal
  */
  #active = new Map<string, {
    task?: string;
    queue?: string;
    attempt?: number;
    startTimeUnixNano: number;
  }>();
  /**
  * Subscribe to the jobs lifecycle topics and begin recording spans.
  *
  * Attaches listeners to `jobs.job.start` and `jobs.job.end`. Start events are
  * buffered by job id; end events flush a completed span into `sdk.recordSpan`.
  * The span's timestamps come from the event `timeUnixNano` when present,
  * falling back to {@link nowUnixNano} at the moment each event is handled.
  *
  * The returned disposable removes both subscriptions; call it during SDK
  * shutdown so the instrumentation stops observing topic traffic. Calling
  * `enable` more than once on the same instance creates independent
  * subscriptions that share the one `#active` map, so prefer a single call per
  * instance.
  *
  * ```ts no_run
  * import { JobsInstrumentation } from 'internal:opentelemetry/instrumentations/jobs';
  * import { getSpanProcessor } from 'internal:opentelemetry/traces.ts';
  *
  * const handle = new JobsInstrumentation().enable({
  *   recordSpan(span) { getSpanProcessor()?.onEnd(span); },
  * });
  *
  * // ... jobs are dispatched and recorded as `JOB <task>` spans ...
  *
  * handle.dispose();
  * ```
  *
  * @internal
  */
  enable(sdk: OtelSdkLike): Disposable {
    const onStart = topic<JobsRuntimeEvent>(otelRuntimeTopic('jobs', 'job', 'start')).subscribe((event) => {
      if (!isTracerProviderContextEnabled()) return;
      if (event.jobId === undefined) return;
      this.#active.set(event.jobId, {
        ...event.task !== undefined ? { task: event.task } : {},
        ...event.queue !== undefined ? { queue: event.queue } : {},
        ...event.attempt !== undefined ? { attempt: event.attempt } : {},
        startTimeUnixNano: event.timeUnixNano || nowUnixNano()
      });
    });
    const onEnd = topic<JobsRuntimeEvent>(otelRuntimeTopic('jobs', 'job', 'end')).subscribe((event) => {
      if (!isTracerProviderContextEnabled()) return;
      if (event.jobId === undefined) return;
      const span = this.#active.get(event.jobId);
      if (!span) return;
      this.#active.delete(event.jobId);
      const failed = event.status === 'failed';
      sdk.recordSpan(createRuntimeClientSpan(`JOB ${span.task ?? 'unknown'}`, 'jobs', event.resource, span.startTimeUnixNano, event.timeUnixNano || nowUnixNano(), {
        'job.id': event.jobId,
        ...span.task !== undefined ? { 'job.task': span.task } : {},
        ...span.queue !== undefined ? { 'job.queue': span.queue } : {},
        ...span.attempt !== undefined ? { 'job.attempt': span.attempt } : {},
        ...event.status !== undefined ? { 'job.outcome': event.status } : {}
      }, failed ? {
        code: 'ERROR',
        message: `job attempt ended with status ${event.status}`
      } : { code: 'OK' }));
    });
    return { dispose() {
      onStart.dispose();
      onEnd.dispose();
    } };
  }
}
