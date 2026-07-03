# Background jobs with fino:jobs

`fino:jobs` runs background work: pushed jobs, retries with backoff, cron
schedules, and durable multi-step runs that survive restarts. Everything is
persisted in a sqlite file, and the unit of work is always a `fino:task`
task — the same definition you can expose as a CLI command or an AI tool.

## Work travels by name

A job row stores a task *name* and a JSON input, never code or a live
object. That is what makes the queue durable: after a restart, any process
that registers a task with that name can pick the job up. Pushing therefore
takes a name, and registration is a separate act:

```ts
import { task } from 'fino:task';
import { Jobs } from 'fino:jobs';

const resize = task({
  name: 'resize',
  run: async (input: { path: string; width: number }) => {
    // ... do the work ...
    return `${input.path}@${input.width}`;
  },
});

await using jobs = await Jobs.open({
  path: './.fino/jobs.db',
  tasks: [resize],            // this realm executes 'resize' jobs inline
});

const job = await jobs.push('resize', { path: 'a.png', width: 320 });
const done = await jobs.wait(job.id);
console.log(done.result);
```

`push()` options cover the usual queue knobs: `delay` (`'5m'`, a
millisecond count, or an absolute `Date`), `priority`, `retry`
(`maxAttempts`, exponential `baseMs`/`factor`/`maxMs`, jitter), and `key` —
a dedupe key that allows at most one *active* job per queue and key, so
double-submits collapse while a job is pending or running but never block a
re-push after it finishes.

## Where handlers run

Two kinds of processors execute claimed jobs:

- **Inline** (`tasks:` at open, or `jobs.process({ tasks })`) runs handlers
  on the current realm's event loop. It is the cheap default for I/O-bound
  work.
- **Worker pools** (`jobs.workers({ entry, size })`) run each job in a
  fresh, exclusive worker realm. The entry module just default-exports a
  `Task` — children included, so one file can define a family of handlers:

```ts
// handlers.ts
import { task } from 'fino:task';

export default task({
  name: 'media',
  run: async () => 'noop',
  children: [
    task({ name: 'resize', run: async (input: { path: string }) => input.path }),
    task({ name: 'transcode', run: async (input: { path: string }) => input.path }),
  ],
});
```

```ts
await jobs.workers({ entry: './handlers.ts', size: 4 });
```

Pool workers use `RealmPool`'s exclusive mode: one job per worker run, with
the realm recycled afterward, so no state leaks between jobs and a stuck job
cannot wedge its slot. Because each job starts in a fresh realm, anything a
handler must remember across attempts belongs in its input, the database, or
a durable task's checkpoints. (Any module that default-exports a `Task`
works as a plain `RealmPool` entry too — the bootstrap turns it into a
dispatcher via `Task.worker()`.)

## Delivery semantics: at-least-once

A job can run more than once: a crash after a side effect, or a worker that
stalls past its lease, reruns it. Write handlers to be idempotent. Failures
retry with exponential backoff until `maxAttempts`, then the job
dead-letters (`status: 'dead'`) with its last error recorded; `jobs.retry(id)`
requeues it from attempt zero. Throw `NonRetryableJobError` to dead-letter
immediately. `jobs.cancel(id)` cancels pending and parked jobs; a running
job is marked cancelled but its in-flight execution is not interrupted.

## Durable jobs

For multi-step work, define the handler with `fino:task/durable`. Steps
checkpoint into the same database, `ctx.sleep()` and `ctx.waitForSignal()`
park the job durably (the row shows `status: 'waiting'`), and the scheduler
wakes it when the timer is due or `jobs.signal(id, name, payload)` arrives.
A retried or restarted durable job *resumes from its last checkpoint* —
completed steps never re-run — which is the built-in answer to the
idempotency requirement:

```ts
import { durableTask } from 'fino:task/durable';

const onboard = durableTask({
  name: 'onboard',
  run: async (input: { email: string }, ctx) => {
    await ctx.step('invite', () => sendInvite(input.email));
    const reply = await ctx.waitForSignal<{ accepted: boolean }>('replied');
    if (reply.accepted) await ctx.step('provision', () => provision(input.email));
    return reply.accepted;
  },
});
```

Durable handlers re-execute from the top on every resume, replaying
completed steps from the store — so side effects belong inside `ctx.step()`
and the step sequence must be deterministic for a given input. Durable jobs
work in both processor kinds; pool workers checkpoint through a facade back
to the service's single database connection.

## Schedules

`jobs.schedule(name, task, input, opts)` persists a named schedule that
enqueues a job on a cadence — a 5-field cron expression, an alias like
`@daily`, or the interval sugar `every: '5m'`. Cron evaluates in **UTC**
(`@daily` is midnight UTC). `overlap: 'skip'` (the default) does not stack a
new run while the previous one is still active; `catchup` controls what
happens after downtime: `'skip'` (default) drops missed firings, `'one'`
fires a single make-up job. `unschedule(name)` removes it.

## One database, one owner

The sqlite file backing jobs must have exactly one open connection per
process and one owning process. Under `fino run` this is automatic: the
runtime's orchestrator hosts the jobs service, `Jobs.open()` becomes a thin
client, and worker pools, schedules, and the scheduler all live outside your
app realm (they drain cleanly when your script finishes). Anywhere else —
tests, embedded use — `Jobs.open()` hosts the service in-realm and `stop()`
(or `await using`) shuts it down. Do not point two processes at one file.

## Observability

Every lifecycle transition publishes a runtime topic event
(`otel:runtime:jobs:*`): enqueue, start, end, retry, dead-letter, park,
schedule firings, and lease expiries. Under `--otlp-endpoint` the bundled
`JobsInstrumentation` turns each execution attempt into a `JOB <task>` span
with the job id, queue, attempt, and outcome attached.
