/**
 * Does realm-to-realm traffic actually bypass the seed?
 *
 * FIN-31 built cert-pinned direct peer sessions and tested them in isolation,
 * but nothing reached them in a running cluster: `cluster join` never opened a
 * listener, so every node advertised no endpoint and the seed relayed all
 * `PORT_MSG` traffic between workers. A control-plane process was carrying the
 * whole data plane, and the unit tests were green throughout — they exercised
 * `PeerMesh` directly rather than the path a real node takes.
 *
 * So the claim under test is not "direct sessions work". It is "direct sessions
 * are what a node actually uses", and the evidence has to be a number the seed
 * itself reports, not an assertion about a class in isolation.
 *
 * The load is a driver node that accepts no workloads of its own and spawns
 * remote realms, which the seed therefore places on the two workers. Every
 * message between the driver and a child is node-to-node traffic that the seed
 * would otherwise carry.
 *
 * ```text
 * fino benchmarks/cluster-mesh.ts
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
/** Ping-pong rounds per child. Enough that a relayed run is unmistakable. */
const ROUNDS = 150;
/** Remote children, spread across the two workers by the seed. */
const CHILDREN = 4;

/** Every process started, so an abnormal exit still cleans up. Orphaned nodes
 * peg a core and corrupt every later measurement on the machine. */
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

interface Measurement {
  /** Frames the seed forwarded between two nodes that are not itself. */
  relayed: number;
  /** Ping-pong replies the driver received. */
  completed: number;
  /** How each worker described itself in `cluster status`. */
  advertised: string[];
}

async function scenario(label: string, mesh: boolean): Promise<Measurement> {
  const port = 3e4 + Math.floor(Math.random() * 1e4);
  const root = `/tmp/fino-mesh-${label}-${Date.now()}`;
  await fs.mkdir(root);
  await fs.mkdir(`${root}/state`);

  const seed = track(
    new Process(
      execPath,
      [
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
      ],
      // The seed reports its relay count on every heartbeat sweep. Reading it
      // from the seed itself is the point: a client-side count would measure
      // the node that decides, not the one that suffers.
      { env: { ...processEnv, FINO_CLUSTER_TRACE: '1' } },
    ),
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

  const joinArgs = mesh ? [] : ['--seed-relay'];
  const workers = ['worker-a', 'worker-b'].map((nodeId) => {
    const proc = track(
      new Process(execPath, ['cluster', 'join', join, '--node-id', nodeId, ...joinArgs]),
    );
    const out: string[] = [];
    collect(proc, out);
    return { nodeId, out };
  });
  for (let i = 0; i < 150; i++) {
    if (workers.every((w) => w.out.join('').includes('joined'))) break;
    await sleep(100);
  }
  for (const worker of workers) {
    if (!worker.out.join('').includes('joined')) throw new Error(`${worker.nodeId} never joined`);
  }

  const status = await run(['cluster', 'status', join], 15_000);
  const advertised = status
    .split('\n')
    .filter((line) => line.startsWith('worker-'))
    .map((line) => `${line.split(' ')[0]}: ${line.includes(' dialable') ? 'dialable' : 'seed-relay'}`);

  // The child fixture lives on the shared filesystem, so a remote spawn can
  // name it by path. Casks are deliberately not involved: this measures the
  // transport, and an artifact-transfer failure would confound it.
  await fs.writeFile(
    `${root}/child.ts`,
    new TextEncoder().encode(
      `import { port } from 'fino:realm/self';\n` +
        `if (port === undefined) throw new Error('child: expected a port');\n` +
        `port.onmessage = (ev) => { port.postMessage(ev.data); };\n` +
        `await new Promise(() => {});\n`,
    ),
  );
  // The driver accepts no workloads, so every child it spawns is placed on a
  // worker and every reply crosses a node boundary.
  await fs.writeFile(
    `${root}/driver.ts`,
    new TextEncoder().encode(
      `import { joinCluster } from 'fino:cluster';\n` +
        `import { Realm } from 'fino:realm';\n` +
        `await joinCluster({\n` +
        `  joinString: ${JSON.stringify(join)},\n` +
        `  nodeId: 'driver',\n` +
        `  acceptWorkloads: false,\n` +
        `  peerListener: ${mesh ? 'undefined' : 'false'},\n` +
        `});\n` +
        `let total = 0;\n` +
        `for (let i = 0; i < ${CHILDREN}; i++) {\n` +
        `  const child = new Realm({ entry: ${JSON.stringify(`${root}/child.ts`)}, remote: true });\n` +
        `  let round = 0;\n` +
        `  child.port.onmessage = () => {\n` +
        `    total++;\n` +
        `    if (++round >= ${ROUNDS}) return;\n` +
        `    child.port.postMessage(round);\n` +
        `  };\n` +
        `  void child.run().catch((err) => console.log('child failed: ' + err));\n` +
        `  await new Promise((r) => setTimeout(r, 300));\n` +
        `  child.port.postMessage(0);\n` +
        `}\n` +
        `const deadline = Date.now() + 60_000;\n` +
        `let last = -1;\n` +
        `while (Date.now() < deadline) {\n` +
        `  await new Promise((r) => setTimeout(r, 1000));\n` +
        `  if (total === last) break;\n` +
        `  last = total;\n` +
        `}\n` +
        `console.log('pingpong replies ' + total);\n`,
    ),
  );

  const driverOut: string[] = [];
  const driver = track(new Process(execPath, [`${root}/driver.ts`]));
  collect(driver, driverOut);
  let completed = 0;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const match = driverOut.join('').match(/pingpong replies (\d+)/);
    if (match !== null) {
      completed = Number(match[1]);
      break;
    }
  }
  const failures = driverOut.join('').split('\n').filter((l) => l.includes('child failed'));
  if (failures.length > 0) console.log(`  [${label}] ${failures.length} child spawn failure(s)`);

  // Give the seed one more sweep so its last trace line covers the whole run.
  await sleep(3000);
  const relayLines = seedOut.join('').match(/seed relayed (\d+) port messages/g) ?? [];
  const relayed =
    relayLines.length === 0 ? -1 : Number(relayLines[relayLines.length - 1]!.match(/(\d+)/)![1]);

  killAll();
  await sleep(500);
  return { relayed, completed, advertised };
}

async function main(): Promise<void> {
  try {
    console.log('--- control: --seed-relay, the behaviour before this change ---');
    const relay = await scenario('relay', false);
    console.log(`  advertised: ${relay.advertised.join(', ')}`);
    console.log(`  ping-pong replies: ${relay.completed}`);
    console.log(`  seed relayed: ${relay.relayed} port messages`);

    console.log('--- default: nodes open their own peer listeners ---');
    const mesh = await scenario('mesh', true);
    console.log(`  advertised: ${mesh.advertised.join(', ')}`);
    console.log(`  ping-pong replies: ${mesh.completed}`);
    console.log(`  seed relayed: ${mesh.relayed} port messages`);

    console.log('--- verdict ---');
    if (relay.relayed <= 0 || relay.completed <= 0) {
      console.log(
        `  PREMISE FAILED: the control run relayed ${relay.relayed} frames over ${relay.completed} replies, so it proves nothing`,
      );
      console.log('  RESULT: inconclusive');
      return;
    }
    if (mesh.completed <= 0) {
      console.log('  RESULT: FAIL — the mesh run carried no traffic at all');
      return;
    }
    // Same work, so the comparison is like for like only if both runs actually
    // completed a comparable number of replies.
    console.log(
      `  work done: ${mesh.completed} replies with a mesh vs ${relay.completed} relayed`,
    );
    console.log(
      mesh.relayed < relay.relayed
        ? `  RESULT: PASS — the seed carried ${mesh.relayed} frames instead of ${relay.relayed} (${((mesh.relayed / relay.relayed) * 100).toFixed(1)}% of the relayed load)`
        : `  RESULT: FAIL — the mesh run still relayed ${mesh.relayed} frames`,
    );
  } finally {
    killAll();
  }
}

await main();
