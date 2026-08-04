/**
 * Shed-pressure scenario: does queued work migrate to a node that joins an
 * overloaded cluster?
 *
 * The balancer only moves **pre-init specs** — once a workload's isolate
 * exists it is pinned to its node — so the whole difficulty is holding a
 * backlog in the pre-init state long enough to observe a migration. Earlier
 * attempts used runaway timer handlers, which the watchdog (correctly)
 * halted, freeing reactors and draining the very backlog under measurement.
 *
 * Slow module evaluation is the right pressure source instead. Each workload
 * occupies its reactor for a bounded time during evaluation, module
 * evaluation is exactly the window where the watchdog stays advisory, and
 * the queue therefore drains at a predictable rate while staying deep. That
 * is also a realistic shape: applications with heavy initialization.
 *
 * The scenario proves the backlog exists (via `cluster status`, which now
 * reports queue depth) before joining the second node, so a negative result
 * can never be blamed on an absent premise.
 *
 * ```text
 * fino benchmarks/cluster-shed.ts              # both directions
 * SHED_ONLY=1 fino benchmarks/cluster-shed.ts  # positive only
 * ```
 */
import { Process, cwd, env as processEnv, execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const decode = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const CERT = `${cwd()}/tests/net/fixtures/test.crt`;
const KEY = `${cwd()}/tests/net/fixtures/test.key`;
const SIGKILL = 9;
/** Enough specs that a two-reactor node cannot initialize them quickly. */
const WAITERS = 24;
/** Seconds of module evaluation per waiter — the reactor occupancy knob. */
const EVAL_SECONDS = 3;

/** Every process started, so an abnormal exit still cleans up. Orphaned
 * nodes peg a core and corrupt every later measurement on the machine. */
const spawned: Process[] = [];

function track(proc: Process): Process {
  spawned.push(proc);
  return proc;
}

function killAll(): void {
  for (const proc of spawned) {
    try {
      proc.kill(SIGKILL);
    } catch {}
  }
  spawned.length = 0;
}

function collect(proc: Process, into: string[]): void {
  const drain = async (stream: Process['stdout']): Promise<void> => {
    try {
      for await (const chunk of stream) into.push(decode(chunk));
    } catch {}
  };
  void drain(proc.stdout);
  void drain(proc.stderr);
}

async function run(args: string[], timeoutMs: number): Promise<string> {
  const proc = track(new Process(execPath, args));
  const parts: string[] = [];
  collect(proc, parts);
  const timer = setTimeout(() => proc.kill(SIGKILL), timeoutMs);
  await proc.wait();
  clearTimeout(timer);
  return parts.join('');
}

/** Pending pre-init specs on one node, as the cluster reports them. */
function pendingFor(status: string, nodeId: string): number {
  const line = status.split('\n').find((l) => l.startsWith(`${nodeId}  `));
  const match = line?.match(/queue (\d+) pending/);
  return match === null || match === undefined ? 0 : Number(match[1]);
}

interface ScenarioResult {
  peakPending: number;
  pendingAtJoin: number;
  ranOnB: number;
  ranOnA: number;
}

async function scenario(label: string, extraEnv: Record<string, string>): Promise<ScenarioResult> {
  const port = 3e4 + Math.floor(Math.random() * 1e4);
  const root = `/tmp/fino-shed-${label}-${Date.now()}`;
  await fs.mkdir(root);
  await fs.mkdir(`${root}/state`);

  const seed = track(
    new Process(execPath, [
      'cluster',
      'start',
      '--port',
      String(port),
      '--cert',
      CERT,
      '--key',
      KEY,
      '--state',
      `${root}/state`,
      '--no-workloads',
    ]),
  );
  const seedOut: string[] = [];
  collect(seed, seedOut);
  let join = '';
  for (let i = 0; i < 100 && join === ''; i++) {
    await sleep(100);
    const match = seedOut.join('').match(/fino:\/\/[^']+/);
    if (match !== null) join = match[0];
  }
  if (join === '') throw new Error('seed never printed a join string');

  // Two reactors: few enough that a burst of slow-init specs queues up.
  const workerA = track(
    new Process(execPath, ['cluster', 'join', join, '--node-id', 'worker-a'], {
      env: {
        ...processEnv,
        FINO_REACTOR_THREADS: '2',
        FINO_SYSTEM_REALM_INTERVAL_MS: '250',
        FINO_CLUSTER_BALANCE_INTERVAL_MS: '500',
        FINO_BALANCE_TRACE: processEnv.SHED_TRACE === '1' ? '1' : '',
        FINO_WATCHDOG_TRACE: processEnv.SHED_TRACE === '1' ? '1' : '',
        FINO_WATCHDOG_INTERVAL_MS: '1000',
        ...extraEnv,
      },
    }),
  );
  const aOut: string[] = [];
  collect(workerA, aOut);
  for (let i = 0; i < 100 && !aOut.join('').includes('joined'); i++) await sleep(100);
  if (!aOut.join('').includes('joined')) throw new Error('worker-a never joined');

  // Slow to evaluate, then quiet: occupies a reactor for a bounded time
  // without ever becoming a runaway the watchdog would halt.
  const app = `${root}/slow`;
  await fs.mkdir(app);
  await fs.writeFile(
    `${app}/main.ts`,
    new TextEncoder().encode(
      `const end = Date.now() + ${EVAL_SECONDS * 1000};\n` +
        `while (Date.now() < end) {}\n` +
        `console.log('slow app ran');\n` +
        `setInterval(() => {}, 60_000);\n`,
    ),
  );

  // Deploys are sequential-ish but not simultaneous: a burst of two dozen
  // concurrent CLI processes is itself a heavier load than the workloads.
  for (let i = 0; i < WAITERS; i++) {
    void run(['cluster', 'deploy', join, app, '--name', `slow${i}`], 180_000);
    await sleep(250);
  }

  // Prove the premise: a real pre-init backlog on worker-a. A negative
  // result is only meaningful if this succeeded.
  //
  // Polling sparingly is not laziness — every `cluster status` spawns a whole
  // fino process, and an earlier version of this scenario polled so often
  // that the observer processes starved worker-a's system realm and made the
  // balancer look broken. The measurement apparatus must not become the load.
  let peakPending = 0;
  for (let i = 0; i < 8; i++) {
    const status = await run(['cluster', 'status', join], 15_000);
    peakPending = Math.max(peakPending, pendingFor(status, 'worker-a'));
    if (peakPending >= 4) break;
    await sleep(1500);
  }
  console.log(`[${label}] peak pending specs on worker-a: ${peakPending}`);

  const atJoin = await run(['cluster', 'status', join], 15_000);
  const pendingAtJoin = pendingFor(atJoin, 'worker-a');
  const workerB = track(
    new Process(execPath, ['cluster', 'join', join, '--node-id', 'worker-b'], {
      env: { ...processEnv, FINO_CLUSTER_BALANCE_INTERVAL_MS: '500' },
    }),
  );
  const bOut: string[] = [];
  collect(workerB, bOut);
  for (let i = 0; i < 100 && !bOut.join('').includes('joined'); i++) await sleep(100);
  console.log(`[${label}] worker-b joined with ${pendingAtJoin} specs pending on worker-a`);

  const countRuns = (out: string[]): number =>
    out
      .join('')
      .split('\n')
      .filter((l) => l.includes('slow app ran')).length;
  let ranOnB = 0;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    ranOnB = countRuns(bOut);
    if (ranOnB > 0) {
      console.log(`[${label}] queued work ran on worker-b after ${i + 1}s`);
      break;
    }
  }

  const ranOnA = countRuns(aOut);
  const final = await run(['cluster', 'status', join], 15_000);
  if (processEnv.SHED_TRACE === '1') {
    console.log(`[${label}] watchdog traces (sampled):`);
    const wd = aOut
      .join('')
      .split('\n')
      .filter((l) => l.includes('fino:watchdog trace'));
    for (const line of wd.slice(0, 6)) console.log(`  ${line}`);
    console.log(`  ... ${wd.length} total`);
    console.log(`[${label}] balance traces (last 12):`);
    for (const line of aOut
      .join('')
      .split('\n')
      .filter((l) => l.includes('fino:balance'))
      .slice(-12)) {
      console.log(`  ${line}`);
    }
  }
  console.log(`[${label}] final status:`);
  for (const line of final.split('\n').filter((l) => l.includes('queue '))) {
    console.log(`  ${line}`);
  }
  console.log(`[${label}] ranOnA=${ranOnA} ranOnB=${ranOnB} peakPending=${peakPending}`);
  killAll();
  return { peakPending, pendingAtJoin, ranOnB, ranOnA };
}

const shedding = await scenario('on', {
  FINO_CLUSTER_SHED_WATERMARK: '1',
  FINO_CLUSTER_SHED_MIN_DELTA: '1',
});
if (processEnv.SHED_ONLY === '1') {
  const ok = shedding.peakPending > 0 && shedding.ranOnB > 0;
  console.log(ok ? '\nSHED PASS (positive only)' : '\nSHED FAIL (positive only)');
} else {
  const held = await scenario('off', {
    FINO_CLUSTER_SHED_WATERMARK: '999',
    FINO_CLUSTER_SHED_MIN_DELTA: '1',
  });
  // Both directions: work migrates when the policy allows it, and stays put
  // when the watermark forbids it. The premise (a real backlog) must hold in
  // both, or the negative proves nothing.
  const pass =
    shedding.peakPending > 0 && shedding.ranOnB > 0 && held.peakPending > 0 && held.ranOnB === 0;
  console.log(pass ? '\nSHED PASS' : '\nSHED FAIL');
}

killAll();
