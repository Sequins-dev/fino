/**
 * Orchestrator e2e fixture: an app script that uses fino:jobs in client mode
 * (the orchestrator hosts the service via the fino:jobs/control facade).
 */
import { Jobs } from 'fino:jobs';
import { task } from 'fino:task';
import { durableTask } from 'fino:task/durable';
import { argv } from 'fino:process';

const dbPath = argv[2] ?? `/tmp/fino-jobs-e2e-${Math.floor(Math.random() * 1e9)}.db`;

const double = task({
  name: 'double',
  run: async (input: { v: number }) => input.v * 2,
});
const gate = durableTask({
  name: 'gate',
  run: async (_input: null, ctx) => {
    const approval = await ctx.waitForSignal<{ ok: boolean }>('go');
    return approval.ok;
  },
});

await using jobs = await Jobs.open({
  path: dbPath,
  tasks: [double, gate],
  pollIntervalMs: 50,
});

const j1 = await jobs.push('double', { v: 21 });
const d1 = await jobs.wait(j1.id, { timeoutMs: 10_000 });
console.log(`double:${d1.result}`);

const j2 = await jobs.push('gate', null);
while ((await jobs.get(j2.id))!.status !== 'waiting') {
  await new Promise<void>((res) => setTimeout(res, 20));
}
await jobs.signal(j2.id, 'go', { ok: true });
const d2 = await jobs.wait(j2.id, { timeoutMs: 10_000 });
console.log(`gate:${d2.result}`);

await jobs.workers({
  entry: new URL('./worker-task.ts', import.meta.url).pathname,
  size: 1,
});
const j3 = await jobs.push('pool-double', { v: 4 });
const d3 = await jobs.wait(j3.id, { timeoutMs: 20_000 });
console.log(`pool:${d3.result}`);
