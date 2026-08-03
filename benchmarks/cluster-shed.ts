/**
 * Shed-pressure scenario: queued work migrating off an overloaded node.
 *
 * The construction that finally works rests on the watchdog. A greedy timer
 * workload wedges worker-a's single reactor; the watchdog halts it, which
 * hands the thread back — and that is what lets the system realm run its
 * balancer at all. The waiters each burn a couple of seconds of legitimate
 * CPU, so the backlog persists while reactors interleave, and when worker-b
 * joins with an empty queue the balancer sheds pre-init specs to it.
 *
 * PASS requires both directions: at least one waiter runs on worker-b under
 * default-ish thresholds, and none migrate when the watermark is prohibitive.
 *
 * ```text
 * fino benchmarks/cluster-shed.ts          # both scenarios
 * SHED_ONLY=1 fino benchmarks/cluster-shed.ts   # positive only, faster
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
  const proc = new Process(execPath, args);
  const parts: string[] = [];
  collect(proc, parts);
  const timer = setTimeout(() => proc.kill(SIGKILL), timeoutMs);
  await proc.wait();
  clearTimeout(timer);
  return parts.join('');
}

interface ScenarioResult {
  backlogBuilt: boolean;
  shedObserved: boolean;
  ranOnA: number;
  halted: boolean;
}

/** Every process this scenario starts, so an abnormal exit still cleans up. */
const spawned: Process[] = [];

function track(proc: Process): Process {
  spawned.push(proc);
  return proc;
}

/**
 * Kill everything, unconditionally. Orphaned cluster nodes from an
 * interrupted run peg a core and quietly corrupt every later measurement on
 * the machine — including full test-suite runs, which then fail at a
 * different random test each time.
 */
function killAll(): void {
  for (const proc of spawned) {
    try {
      proc.kill(SIGKILL);
    } catch {}
  }
  spawned.length = 0;
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

  // Saturate the POOL, not the machine. Flooding every hardware thread with
  // greedy workloads starves the main thread too, and the node misses
  // heartbeats and gets swept from membership before any of this matters —
  // OS-level starvation no watchdog can fix. Capping reactors at two leaves
  // the rest of the box for the control plane, so what gets tested is the
  // scheduler rather than the machine. (A cap of one hangs node startup;
  // tracked separately.)
  const workerEnv = {
    ...processEnv,
    FINO_REACTOR_THREADS: '2',
    FINO_WATCHDOG_TRACE: processEnv.SHED_TRACE === '1' ? '1' : '',
    FINO_SYSTEM_REALM_INTERVAL_MS: '250',
    FINO_CLUSTER_BALANCE_INTERVAL_MS: '1000',
    FINO_WATCHDOG_INTERVAL_MS: '200',
    FINO_WATCHDOG_STALL_MS: '1000',
    FINO_WATCHDOG_SUSTAINED_MS: '3000',
    ...extraEnv,
  };
  const workerA = track(
    new Process(execPath, ['cluster', 'join', join, '--node-id', 'worker-a'], { env: workerEnv }),
  );
  const aOut: string[] = [];
  collect(workerA, aOut);
  for (let i = 0; i < 100 && !aOut.join('').includes('joined'); i++) await sleep(100);
  if (!aOut.join('').includes('joined')) throw new Error('worker-a never joined');

  // Greedy: a timer handler that never yields. Timer-based deliberately —
  // a top-level runaway sits in module evaluation, where the watchdog
  // stays advisory by design.
  const busy = `${root}/busy`;
  await fs.mkdir(busy);
  await fs.writeFile(
    `${busy}/main.ts`,
    new TextEncoder().encode(`setTimeout(() => {\n  for (;;) {}\n}, 20);\n`),
  );
  // Waiters: two seconds of honest CPU each, then a print that reveals
  // which node they actually ran on.
  const waiting = `${root}/waiting`;
  await fs.mkdir(waiting);
  await fs.writeFile(
    `${waiting}/main.ts`,
    new TextEncoder().encode(
      `setTimeout(() => {\n  const end = Date.now() + 2000;\n  while (Date.now() < end) {}\n  console.log('waiting app ran');\n  setInterval(() => {}, 60_000);\n}, 10);\n`,
    ),
  );

  // Three against a two-thread pool: both reactors wedged with one waiting,
  // so every halt is immediately followed by another wedge and the backlog
  // persists while the balancer looks at it.
  const GREEDY = 3;
  const busyDeploys: Promise<string>[] = [];
  for (let i = 0; i < GREEDY; i++) {
    busyDeploys.push(run(['cluster', 'deploy', join, busy, '--name', `busy${i}`], 120_000));
  }
  await sleep(6000);
  const queued: Promise<string>[] = [];
  for (let i = 0; i < 6; i++) {
    queued.push(run(['cluster', 'deploy', join, waiting, '--name', `wait${i}`], 120_000));
  }
  await sleep(5000);
  const backlogBuilt = !aOut.join('').includes('waiting app ran');

  const workerB = track(
    new Process(execPath, ['cluster', 'join', join, '--node-id', 'worker-b'], {
      env: { ...processEnv, FINO_CLUSTER_BALANCE_INTERVAL_MS: '1000' },
    }),
  );
  const bOut: string[] = [];
  collect(workerB, bOut);
  for (let i = 0; i < 100 && !bOut.join('').includes('joined'); i++) await sleep(100);
  console.log(`[${label}] worker-b joined; watching for migration`);

  let shedObserved = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (bOut.join('').includes('waiting app ran')) {
      shedObserved = true;
      console.log(`[${label}] queued work ran on worker-b after ${i + 1}s`);
      break;
    }
  }

  const ranOnA = aOut
    .join('')
    .split('\n')
    .filter((l) => l.includes('waiting app ran')).length;
  const halted = aOut.join('').includes('terminated while holding its reactor');
  // Deploy outcomes are part of the record: silent CLI failures have twice
  // masqueraded as scheduler behavior in this scenario's history.
  const lastLine = (out: string): string => {
    const lines = out.trim().split('\n');
    return lines.find((l) => l.includes('rror')) ?? lines.pop() ?? '';
  };
  for (const [index, outcome] of (await Promise.all(busyDeploys)).entries()) {
    const line = lastLine(outcome);
    if (line.includes('rror')) console.log(`[${label}] busy${index}: ${line}`);
  }
  for (const [index, outcome] of (await Promise.all(queued)).entries()) {
    console.log(`[${label}] wait${index}: ${lastLine(outcome)}`);
  }
  console.log(`[${label}] worker-a tail:`);
  for (const line of aOut.join('').split('\n').slice(-8)) console.log(`  ${line}`);
  void workerA;
  void workerB;
  void seed;
  killAll();
  console.log(
    `[${label}] backlog=${backlogBuilt} shed=${shedObserved} ranOnA=${ranOnA} watchdogHalted=${halted}`,
  );
  return { backlogBuilt, shedObserved, ranOnA, halted };
}

const shedding = await scenario('on', {
  FINO_CLUSTER_SHED_WATERMARK: '1',
  FINO_CLUSTER_SHED_MIN_DELTA: '1',
});
if (processEnv.SHED_ONLY === '1') {
  console.log(
    shedding.shedObserved ? '\nSHED PASS (positive only)' : '\nSHED FAIL (positive only)',
  );
} else {
  const held = await scenario('off', {
    FINO_CLUSTER_SHED_WATERMARK: '999',
    FINO_CLUSTER_SHED_MIN_DELTA: '1',
  });
  // The halted marker is informational: a halted realm's error settles
  // toward its (departed) deploy CLI, so worker-a's log rarely shows it.
  const pass = shedding.backlogBuilt && shedding.shedObserved && !held.shedObserved;
  console.log(pass ? '\nSHED PASS' : '\nSHED FAIL');
}

// Belt and braces: whatever path reached here, nothing this script started
// is left running.
killAll();
