/**
 * How well does the balancer actually balance, and what do the knobs do?
 *
 * `cluster-shed.ts` answers a yes/no question — does queued work ever migrate
 * — and stops observing at the first sign that it did. That makes its
 * `ranOnB=1` a premise check, not a measurement, and it cannot say whether a
 * setting distributes work well or merely distributes it at all.
 *
 * This measures volume and cost instead: of N workloads queued on a saturated
 * node, how many end up running on the node that joins afterwards, how long
 * the split takes to settle, and how much work the balancer wasted getting
 * there. `refused` and `reclaimed` are the waste — an offer the target turned
 * down, and a spec a local reactor claimed between mark and take. A setting
 * that moves work by churning through refusals is not a good setting.
 *
 * The three knobs (FIN-41):
 *   FINO_CLUSTER_SHED_WATERMARK  local pending depth before shedding starts
 *   FINO_CLUSTER_SHED_MIN_DELTA  how much heavier than a peer we must be
 *   FINO_CLUSTER_SHED_BATCH      specs one pass may move
 *
 * ```text
 * fino benchmarks/cluster-balance.ts          # the sweep
 * BALANCE_CASE=aggressive fino benchmarks/…   # one case, with full traces
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
/** Total workloads deployed across the run. */
const WAITERS = 40;
/** Gap between deploys. Faster than two reactors can drain, so a queue forms. */
const DEPLOY_INTERVAL_MS = 700;
/** Seconds of module evaluation per waiter — the reactor-occupancy knob. */
const EVAL_SECONDS = 3;
/** How long to watch the split settle after the second node joins. */
const OBSERVE_SECONDS = 150;
/** How long worker-a runs alone before worker-b joins, building a backlog. */
const JOIN_AFTER_MS = 6000;

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

const countRuns = (out: string[]): number =>
  out.join('').split('\n').filter((l) => l.includes('slow app ran')).length;

/** Sum the balancer's own accounting across every pass it logged. */
function balanceTotals(out: string[]): { shed: number; refused: number; reclaimed: number } {
  const totals = { shed: 0, refused: 0, reclaimed: 0 };
  for (const line of out.join('').split('\n')) {
    const match = line.match(/fino:balance outcome (\{.*\})/);
    if (match === null) continue;
    try {
      const parsed = JSON.parse(match[1]!) as typeof totals;
      totals.shed += parsed.shed ?? 0;
      totals.refused += parsed.refused ?? 0;
      totals.reclaimed += parsed.reclaimed ?? 0;
    } catch {}
  }
  return totals;
}

interface Knobs {
  watermark: string;
  minDelta: string;
  batch: string;
}

interface Result extends Knobs {
  label: string;
  peakPending: number;
  pendingAtJoin: number;
  ranOnA: number;
  ranOnB: number;
  shed: number;
  refused: number;
  reclaimed: number;
  settleSeconds: number | null;
  placedOnA: number;
  placedOnB: number;
  bJoined: boolean;
  /** Deploys issued before worker-b existed; those could never land on it. */
  deployedBeforeJoin: number;
}

async function scenario(label: string, knobs: Knobs): Promise<Result> {
  const port = 3e4 + Math.floor(Math.random() * 1e4);
  const root = `/tmp/fino-balance-${label}-${Date.now()}`;
  await fs.mkdir(root);
  await fs.mkdir(`${root}/state`);

  const seed = track(
    new Process(execPath, [
      'cluster', 'start', '--port', String(port),
      '--cert', CERT, '--key', KEY,
      '--state', `${root}/state`, '--no-workloads',
    ], { env: { ...processEnv, FINO_CLUSTER_TRACE: '1' } }),
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

  const workerEnv = {
    ...processEnv,
    FINO_REACTOR_THREADS: '2',
    FINO_SYSTEM_REALM_INTERVAL_MS: '250',
    FINO_CLUSTER_BALANCE_INTERVAL_MS: '500',
    FINO_BALANCE_TRACE: '1',
    FINO_WATCHDOG_INTERVAL_MS: '1000',
    FINO_CLUSTER_SHED_WATERMARK: knobs.watermark,
    FINO_CLUSTER_SHED_MIN_DELTA: knobs.minDelta,
    FINO_CLUSTER_SHED_BATCH: knobs.batch,
  };
  const workerA = track(
    new Process(execPath, ['cluster', 'join', join, '--node-id', 'worker-a'], { env: workerEnv }),
  );
  const aOut: string[] = [];
  collect(workerA, aOut);
  for (let i = 0; i < 100 && !aOut.join('').includes('joined'); i++) await sleep(100);
  if (!aOut.join('').includes('joined')) throw new Error('worker-a never joined');

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

  // Deploys continue through the whole run, including after worker-b joins.
  //
  // Front-loading them measures the wrong thing: two reactors drain a burst
  // faster than a new node can join and be seen, so the balancer wakes to a
  // queue of one and correctly does nothing. That is the cold-cluster trade
  // the design already acknowledges, not a policy under test. Sustained
  // pressure is what tells the knobs apart.
  let deployed = 0;
  // Where the seed chose to put each deployment, which is a different question
  // from where it ended up running. Placement is enqueue-time spread; shedding
  // is the corrective loop. Counting only the final split cannot tell them
  // apart, and they have different fixes.
  const placements: string[] = [];
  const deployer = (async (): Promise<void> => {
    while (deployed < WAITERS) {
      const name = `slow${deployed}`;
      void run(['cluster', 'deploy', join, app, '--name', name], 180_000).then((out) => {
        const match = out.match(/deployed \S+ -> (\S+?)\//);
        if (match !== null) placements.push(match[1]!);
      });
      deployed++;
      await sleep(DEPLOY_INTERVAL_MS);
    }
  })();

  // Prove the premise before measuring: a real pre-init backlog on worker-a.
  // Poll sparingly — every `cluster status` spawns a whole fino process, and
  // the measurement apparatus must not become part of the load.
  // Let a backlog build, then bring worker-b in while deploys are still
  // flowing. The premise is read from worker-a's own balance traces afterwards
  // rather than by polling `cluster status`: each status call spawns a whole
  // fino process and takes seconds, and an earlier version of this harness
  // spent the entire deploy window inside that poll loop. Worker-b did not
  // exist until after the last deployment had been placed, which made
  // placement look broken when it had simply never been offered the choice.
  await sleep(JOIN_AFTER_MS);
  const deployedBeforeJoin = deployed;

  const workerB = track(
    new Process(execPath, ['cluster', 'join', join, '--node-id', 'worker-b'], { env: workerEnv }),
  );
  const bOut: string[] = [];
  collect(workerB, bOut);
  for (let i = 0; i < 150 && !bOut.join('').includes('joined'); i++) await sleep(100);
  const bJoined = bOut.join('').includes('joined');
  if (!bJoined) console.log(`  [${label}] WARNING: worker-b never joined — this row measures nothing`);

  // Watch the whole window rather than stopping at the first migration: the
  // question is how much moves, not whether anything does.
  let settleSeconds: number | null = null;
  let lastTotal = -1;
  let stableFor = 0;
  for (let i = 0; i < OBSERVE_SECONDS; i++) {
    await sleep(1000);
    const total = countRuns(aOut) + countRuns(bOut);
    // Only call it settled once every deploy has been issued; before that a
    // quiet second means the deployer is between deploys, not that the work
    // is done.
    if (deployed >= WAITERS && total === lastTotal && total > 0) {
      stableFor++;
      if (stableFor >= 4) {
        settleSeconds = i + 1;
        break;
      }
    } else {
      stableFor = 0;
    }
    lastTotal = total;
  }
  await deployer;

  // Deepest pre-init queue worker-a ever reported, straight from its own
  // balancer traces — free, and finer-grained than polling could be.
  const depths = aOut
    .join('')
    .split('\n')
    .map((l) => l.match(/fino:balance trace .*pending=(\d+)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]));
  const peakPending = depths.length === 0 ? 0 : Math.max(...depths);
  const pendingAtJoin = peakPending;
  const totals = balanceTotals(aOut);
  const result: Result = {
    label,
    ...knobs,
    peakPending,
    pendingAtJoin,
    ranOnA: countRuns(aOut),
    ranOnB: countRuns(bOut),
    ...totals,
    settleSeconds,
    placedOnA: placements.filter((n) => n === 'worker-a').length,
    placedOnB: placements.filter((n) => n === 'worker-b').length,
    bJoined,
    deployedBeforeJoin,
  };

  if (processEnv.BALANCE_CASE === label) {
    const all = aOut.join('').split('\n').filter((l) => l.includes('fino:balance'));
    // The only interesting passes are the ones where there was both a backlog
    // and somewhere to send it. Everything else is the balancer correctly
    // doing nothing.
    const actionable = all.filter((l) => l.includes('peers=[{') && !l.includes('pending=0'));
    console.log(`\n[${label}] passes with a backlog AND a candidate peer:`);
    for (const line of actionable.slice(0, 30)) console.log(`  ${line}`);
    console.log(
      `  ... ${actionable.length} of ${all.length} traces had both ` +
        `(${all.filter((l) => l.includes('peers=[]')).length} saw no peers at all)\n`,
    );
    const selects = seedOut
      .join('')
      .split('\n')
      .filter((l) => l.includes('fino:cluster placement'));
    console.log(`[${label}] last 20 placement decisions:`);
    for (const line of selects.slice(-20)) console.log(`  ${line}`);
  }

  killAll();
  await sleep(500);
  return result;
}

function report(rows: Result[]): void {
  console.log('\n=== balancer knob sweep ===');
  console.log(
    '  watermark/minDelta/batch   ranA  ranB   split   shed  refused  placedA  placedB  preJoin  settle',
  );
  for (const r of rows) {
    const total = r.ranOnA + r.ranOnB;
    const split = total === 0 ? 'n/a' : `${Math.round((r.ranOnB / total) * 100)}% B`;
    const knobs = `${r.watermark}/${r.minDelta}/${r.batch}`.padEnd(24);
    console.log(
      `  ${knobs}  ${String(r.ranOnA).padStart(4)}  ${String(r.ranOnB).padStart(4)}  ` +
        `${split.padStart(6)}  ${String(r.shed).padStart(4)}  ${String(r.refused).padStart(7)}  ` +
        `${String(r.placedOnA).padStart(7)}  ${String(r.placedOnB).padStart(7)}  ` +
        `${String(r.deployedBeforeJoin).padStart(7)}  ` +
        `${r.settleSeconds === null ? '  none' : `${r.settleSeconds}s`.padStart(6)}` +
        `${r.bJoined ? '' : '   [worker-b never joined]'}`,
    );
  }
  console.log(
    '\n  split   = share of workloads that RAN on the node which joined late.' +
      '\n  placedA/B = where the seed CHOSE to put each deployment at enqueue time.' +
      '\n  A split that tracks `shed` with placedB near zero means the corrective loop is' +
      '\n  doing all the work and enqueue-time spread is contributing nothing.',
  );
  const premiseFailed = rows.filter((r) => r.peakPending === 0);
  if (premiseFailed.length > 0) {
    console.log(
      `\n  PREMISE FAILED for ${premiseFailed.map((r) => r.label).join(', ')}: ` +
        'no backlog ever formed, so those rows measure nothing.',
    );
  }
}

const CASES: Array<{ label: string } & Knobs> = [
  // The shipped defaults.
  { label: 'default', watermark: '2', minDelta: '2', batch: '2' },
  // What cluster-shed.ts uses to prove migration happens at all.
  { label: 'eager', watermark: '1', minDelta: '1', batch: '2' },
  // Move more per pass: does a bigger batch settle faster, or just churn?
  { label: 'big-batch', watermark: '2', minDelta: '2', batch: '8' },
  // Wide hysteresis, the staleness defence the design calls for.
  { label: 'conservative', watermark: '8', minDelta: '6', batch: '4' },
  // Control: shedding effectively disabled.
  { label: 'off', watermark: '999', minDelta: '1', batch: '2' },
];

async function main(): Promise<void> {
  const only = processEnv.BALANCE_CASE;
  const cases = only === undefined ? CASES : CASES.filter((c) => c.label === only);
  const rows: Result[] = [];
  try {
    for (const testCase of cases) {
      console.log(`--- ${testCase.label}: watermark=${testCase.watermark} ` +
        `minDelta=${testCase.minDelta} batch=${testCase.batch} ---`);
      const result = await scenario(testCase.label, testCase);
      console.log(
        `  ranOnA=${result.ranOnA} ranOnB=${result.ranOnB} ` +
          `shed=${result.shed} refused=${result.refused} reclaimed=${result.reclaimed} ` +
          `peakPending=${result.peakPending}`,
      );
      rows.push(result);
    }
    report(rows);
  } finally {
    killAll();
  }
}

await main();
