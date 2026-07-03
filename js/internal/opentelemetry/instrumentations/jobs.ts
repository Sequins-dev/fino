/**
* internal/opentelemetry/instrumentations/jobs — internal runtime module.
*
* Converts `fino:jobs` job lifecycle topic events into spans. Active job
* executions are tracked by job id from `jobs.job.start` until the matching
* `jobs.job.end` arrives; the end event's status distinguishes completions,
* parks, and failures.
*
* ```js
* const { JobsInstrumentation } =
*   import 'internal:opentelemetry/instrumentations/jobs';
* const instrumentation = new JobsInstrumentation();
* console.log(typeof instrumentation.enable);
* ```
*
* @internal
*/
import { topic } from '../../../context/topic.ts';
import { nowUnixNano, otelRuntimeTopic } from '../common.ts';
import type { Disposable, OtelSdkLike } from '../common.ts';
import { createRuntimeClientSpan } from './_runtime-client.ts';
import { isTracerProviderContextEnabled } from '../traces.ts';

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
* Runtime jobs instrumentation.
*
* Subscribes to `jobs.job.start` and `jobs.job.end` topics and records one
* span per job execution attempt, named `JOB <task>`. Records spans only
* while tracer context recording is enabled; missing start events are
* ignored, and dispose removes all subscriptions.
*
* ```js
* const { JobsInstrumentation } =
*   import 'internal:opentelemetry/instrumentations/jobs';
* const disposable = new JobsInstrumentation().enable({ recordSpan() {} });
* disposable.dispose();
* ```
*
* @internal
*/
export class JobsInstrumentation {
  /**
  * Private property `#active` — in-flight job executions by job id.
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
  * Enable jobs topic subscriptions.
  *
  * The returned disposable must be called during SDK shutdown to
  * unsubscribe.
  *
  * ```js
  * const { JobsInstrumentation } =
  *   import 'internal:opentelemetry/instrumentations/jobs';
  * const disposable = new JobsInstrumentation().enable({ recordSpan() {} });
  * disposable.dispose();
  * ```
  *
  * @param sdk SDK-like sink that accepts completed spans.
  * @returns A disposable that removes all jobs subscriptions.
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
