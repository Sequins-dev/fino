/**
 * Shed-pressure scenario: does queued work actually migrate to a node that
 * joins an overloaded cluster?
 *
 * The balancer only acts on pre-initialization specs, so a backlog has to
 * exist before anything can move. This builds one deliberately: a
 * control-plane-only seed (never a placement target — application load must
 * not starve the loop that routes the cluster), one worker capped to a
 * single reactor thread, and a busy-spin workload that wedges that thread so
 * everything deployed behind it stays queued as a spec. Then a second worker
 * joins, and the question is whether the backlog drains onto it.
 *
 * ```text
 * fino benchmarks/cluster-shed.ts
 * ```
 */
import { Process, cwd, env as processEnv, execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const decode = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const PORT = 3e4 + Math.floor(Math.random() * 1e4);
const ROOT = `/tmp/fino-shed-${Date.now()}`;
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

async function main(): Promise<void> {
  await fs.mkdir(ROOT);
  await fs.mkdir(`${ROOT}/state`);

  // Control-plane-only seed: never a placement target, so the loop routing
  // the cluster can never be starved by the load this scenario creates.
  const seed = new Process(execPath, [
    'cluster', 'start',
    '--port', String(PORT),
    '--cert', CERT,
    '--key', KEY,
    '--state', `${ROOT}/state`,
    '--no-workloads',
  ]);
  const seedOut: string[] = [];
  collect(seed, seedOut);
  let join = '';
  for (let i = 0; i < 100 && join === ''; i++) {
    await sleep(100);
    const match = seedOut.join('').match(/fino:\/\/[^']+/);
    if (match !== null) join = match[0];
  }
  if (join === '') throw new Error('seed never printed a join string');

  // One worker, one reactor thread: a single busy workload wedges it and
  // everything behind stays a queued spec.
  const workerA = new Process(execPath, ['cluster', 'join', join, '--node-id', 'worker-a'], {
    env: { ...processEnv, FINO_REACTOR_THREADS: '1', FINO_CLUSTER_BALANCE_INTERVAL_MS: '1000' },
  });
  const aOut: string[] = [];
  collect(workerA, aOut);
  for (let i = 0; i < 100 && !aOut.join('').includes('joined'); i++) await sleep(100);

  const busy = `${ROOT}/busy`;
  await fs.mkdir(busy);
  await fs.writeFile(
    `${busy}/main.ts`,
    new TextEncoder().encode(`const end = Date.now() + 120_000;\nwhile (Date.now() < end) {}\n`),
  );
  const waiting = `${ROOT}/waiting`;
  await fs.mkdir(waiting);
  await fs.writeFile(
    `${waiting}/main.ts`,
    new TextEncoder().encode(`console.log('waiting app ran');\nsetInterval(() => {}, 60000);\n`),
  );

  void run(['cluster', 'deploy', join, busy, '--name', 'busy'], 150_000);
  await sleep(4000);
  const queued: Promise<string>[] = [];
  for (let i = 0; i < 5; i++) {
    queued.push(run(['cluster', 'deploy', join, waiting, '--name', `wait${i}`], 150_000));
  }
  await sleep(6000);

  const beforeStatus = await run(['cluster', 'status', join], 15_000);
  console.log('--- before the second worker joins:');
  console.log(beforeStatus.split('\n').filter((l) => l.includes('cpu')).join('\n'));

  // The new node: an empty queue next to a wedged one is exactly the
  // imbalance the balancer exists to correct.
  const workerB = new Process(execPath, ['cluster', 'join', join, '--node-id', 'worker-b'], {
    env: { ...processEnv, FINO_CLUSTER_BALANCE_INTERVAL_MS: '1000' },
  });
  const bOut: string[] = [];
  collect(workerB, bOut);
  for (let i = 0; i < 100 && !bOut.join('').includes('joined'); i++) await sleep(100);
  console.log('worker-b joined; watching for migration');

  let ranOnB = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (bOut.join('').includes('waiting app ran')) {
      ranOnB = true;
      console.log(`queued work ran on worker-b after ${i + 1}s`);
      break;
    }
  }

  const afterStatus = await run(['cluster', 'status', join], 15_000);
  console.log('--- after:');
  console.log(afterStatus.split('\n').filter((l) => l.includes('cpu')).join('\n'));
  console.log(`worker-a output: ${aOut.join('').split('\n').filter((l) => l.includes('waiting app ran')).length} waiting apps ran locally`);

  void queued;
  workerA.kill(SIGKILL);
  workerB.kill(SIGKILL);
  seed.kill(SIGKILL);
  console.log(ranOnB ? '\nSHED PASS: queued work migrated to the new node' : '\nSHED FAIL: backlog never moved');
}

await main();
