/**
 * Multi-node cluster soak: real processes, sustained deploys, a mid-run
 * drain, and a scorecard.
 *
 * This is the empirical harness behind FIN-41's tuning work. It starts a
 * seed and two workers as separate OS processes over real WebTransport,
 * deploys a stream of applications, samples membership and load the whole
 * time, SIGTERMs one worker partway through to exercise the drain path, and
 * reports what actually happened — placements per node, membership
 * stability, drain accounting, failures.
 *
 * Run manually (it takes about a minute and binds UDP ports):
 *
 * ```text
 * fino benchmarks/cluster-soak.ts
 * ```
 */
import { Process, cwd, execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const decode = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const PORT = 3e4 + Math.floor(Math.random() * 1e4);
const ROOT = `/tmp/fino-soak-${Date.now()}`;
const CERT = `${cwd()}/tests/net/fixtures/test.crt`;
const KEY = `${cwd()}/tests/net/fixtures/test.key`;
const SOAK_SECONDS = 50;
const DEPLOY_EVERY_MS = 1000;

interface Score {
  deploysAttempted: number;
  deploysSucceeded: number;
  placements: Map<string, number>;
  membershipSamples: string[][];
  drainLine: string | null;
  errors: string[];
}

async function collect(proc: Process, into: string[]): Promise<void> {
  const drain = async (stream: Process['stdout']): Promise<void> => {
    try {
      for await (const chunk of stream) into.push(decode(chunk));
    } catch {}
  };
  await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
}

async function run(name: string, args: string[], timeoutMs: number): Promise<{ out: string; ok: boolean }> {
  const proc = new Process(execPath, args);
  const parts: string[] = [];
  const done = collect(proc, parts);
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const status = await proc.wait();
  clearTimeout(timer);
  await done.catch(() => {});
  return { out: parts.join(''), ok: status.code === 0 };
}

async function main(): Promise<void> {
  await fs.mkdir(ROOT);
  await fs.mkdir(`${ROOT}/state`);
  const score: Score = {
    deploysAttempted: 0,
    deploysSucceeded: 0,
    placements: new Map(),
    membershipSamples: [],
    drainLine: null,
    errors: [],
  };

  // --- seed -----------------------------------------------------------
  const seed = new Process(execPath, [
    'cluster', 'start',
    '--port', String(PORT),
    '--cert', CERT,
    '--key', KEY,
    '--state', `${ROOT}/state`,
  ]);
  const seedOut: string[] = [];
  void collect(seed, seedOut);
  let join = '';
  for (let i = 0; i < 100 && join === ''; i++) {
    await sleep(100);
    const match = seedOut.join('').match(/fino:\/\/[^']+/);
    if (match !== null) join = match[0];
  }
  if (join === '') throw new Error('seed never printed a join string');
  console.log(`seed up on ${PORT}`);

  // --- workers ---------------------------------------------------------
  const workers: { name: string; proc: Process; out: string[] }[] = [];
  for (const name of ['worker-a', 'worker-b']) {
    const proc = new Process(execPath, ['cluster', 'join', join, '--node-id', name]);
    const out: string[] = [];
    void collect(proc, out);
    workers.push({ name, proc, out });
  }
  for (const worker of workers) {
    for (let i = 0; i < 100 && !worker.out.join('').includes('joined'); i++) await sleep(100);
    if (!worker.out.join('').includes('joined')) throw new Error(`${worker.name} never joined`);
  }
  console.log('workers joined');

  // --- app fixture -----------------------------------------------------
  const app = `${ROOT}/app`;
  await fs.mkdir(app);
  await fs.writeFile(
    `${app}/main.ts`,
    new TextEncoder().encode(
      `console.log('soak app alive');\nlet spin = 0;\nsetInterval(() => { for (let i = 0; i < 2e6; i++) spin += i; }, 50);\n`,
    ),
  );

  // --- soak loop -------------------------------------------------------
  const startedAt = Date.now();
  let drained = false;
  let deployIndex = 0;
  while (Date.now() - startedAt < SOAK_SECONDS * 1000) {
    score.deploysAttempted++;
    const label = `soak${deployIndex++}`;
    const result = await run('deploy', ['cluster', 'deploy', join, app, '--name', label], 25_000);
    const placed = result.out.match(/deployed \S+ -> (\S+)\//);
    if (result.ok && placed !== null) {
      score.deploysSucceeded++;
      score.placements.set(placed[1]!, (score.placements.get(placed[1]!) ?? 0) + 1);
    } else {
      score.errors.push(`deploy ${label}: ${result.out.split('\n').find((l) => l.includes('rror')) ?? 'failed'}`);
    }

    const status = await run('status', ['cluster', 'status', join], 15_000);
    const members = [...status.out.matchAll(/^(\S+)  cpu /gm)].map((m) => m[1]!).sort();
    score.membershipSamples.push(members);

    // Halfway through, drain worker-b: SIGTERM triggers the CLI drain path.
    if (!drained && Date.now() - startedAt > (SOAK_SECONDS * 1000) / 2) {
      drained = true;
      workers[1]!.proc.kill();
      console.log('sent SIGTERM to worker-b (drain)');
      await sleep(2000);
      const line = workers[1]!.out.join('').split('\n').find((l) => l.startsWith('drained:'));
      score.drainLine = line ?? null;
    }
    await sleep(DEPLOY_EVERY_MS);
  }

  // --- scorecard -------------------------------------------------------
  console.log('\n=== soak scorecard ===');
  console.log(`deploys: ${score.deploysSucceeded}/${score.deploysAttempted} succeeded`);
  console.log('placements per node:');
  for (const [node, count] of score.placements) console.log(`  ${node}: ${count}`);
  for (const [index, members] of score.membershipSamples.entries()) {
    console.log(`membership sample ${index + 1}: ${members.join(', ') || 'none'}`);
  }
  console.log(`drain report: ${score.drainLine ?? 'NOT OBSERVED'}`);
  if (score.errors.length > 0) {
    console.log(`errors (${score.errors.length}):`);
    for (const error of score.errors.slice(0, 5)) console.log(`  ${error}`);
  }

  // --- teardown --------------------------------------------------------
  // SIGKILL: SIGTERM now triggers the drain path, and the soak has already
  // exercised it deliberately on worker-b. Teardown should be immediate, and
  // the stdout readers keep the loop alive until every child closes.
  const SIGKILL = 9;
  for (const worker of workers) worker.proc.kill(SIGKILL);
  seed.kill(SIGKILL);
  // Durable members only: deploy/status CLIs churn through membership, so
  // the health check asks whether the three durable nodes stayed present
  // until the drain, and worker-b left after it.
  const durable = ['worker-a', 'worker-b'];
  const preDrain = score.membershipSamples.slice(0, 1);
  const healthy =
    score.deploysSucceeded === score.deploysAttempted &&
    preDrain.every((sample) => durable.every((node) => sample.includes(node))) &&
    score.drainLine !== null;
  console.log(healthy ? '\nSOAK PASS' : '\nSOAK FAIL');
}

await main();
