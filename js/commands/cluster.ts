/**
 * fino:commands/cluster — reusable `fino cluster` command task.
 *
 * The cluster lifecycle is explicit and entrypoint-free: `start` and `join`
 * bring up the local runtime substrate and keep the node alive until a
 * signal; an app arrives later through deployment. `status` connects as an
 * observer — it reads the membership snapshot without ever becoming a
 * member — prints it, and exits.
 *
 * `start` mints a join string embedding the seed endpoint, cluster identity,
 * join token, and the seed certificate's sha-256 hash. `join` consumes that
 * one secret and gets token authentication plus pinned TLS identity with no
 * CA distribution.
 *
 * ```text
 * fino cluster start --port 4433 --cert ./cert.pem --key ./key.pem
 *   -> join with: fino cluster join 'fino://10.0.0.5:4433/__fino_cluster#cid:…,tok:…,sha256:…'
 *
 * fino cluster join '<join-string>'
 * fino cluster status '<join-string>'
 * ```
 */
import { Task } from '../task.ts';
import { stdout } from '../process.ts';
import {
  clusterJoinString,
  drainCluster,
  getCluster,
  joinCluster,
  leaveCluster,
  startCluster,
} from '../cluster.ts';
import { parseJoinString } from '../internal/cluster/join-string.ts';
import { packCask } from '../internal/cluster/cask.ts';
import { ClusterPort } from '../internal/cluster/client.ts';
import { WebTransportWorkerTransport } from '../internal/cluster/webtransport-transport.ts';
import { ClusterClient } from '../internal/cluster/client.ts';
import { sampleNodeLoad } from '../internal/runtime/stats.ts';
import * as loop from 'internal:runtime/loop';

const SIGINT = 2;
const SIGTERM = 15;

const enc = new TextEncoder();
async function print(text: string): Promise<void> {
  await stdout().write(enc.encode(text));
  await stdout().flush();
}

function mintToken(): string {
  const raw = new Uint8Array(24);
  crypto.getRandomValues(raw);
  return Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * Resolve when the node should shut down: the task context aborts, or the
 * process receives SIGTERM/SIGINT. Watching the signals suppresses their
 * default disposition, which is the whole point — the caller drains the
 * node's workloads before letting the process exit.
 */
function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      loop.removeSignal(SIGTERM);
      loop.removeSignal(SIGINT);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    try {
      loop.signal(SIGTERM, done);
      loop.signal(SIGINT, done);
    } catch {
      // Platforms without signal watching still stop via the task context.
    }
  });
}

const startCommand = new Task({
  name: 'start',
  description: 'Start a cluster seed node and print its join string',
  outputMode: 'text',
  cli: {
    options: [
      { flags: '--port', type: 'string', description: 'UDP port for the HTTP/3 seed listener' },
      { flags: '--hostname', type: 'string', description: 'Bind address; also advertised in the join string' },
      { flags: '--cert', type: 'string', description: 'Path to the PEM certificate chain' },
      { flags: '--key', type: 'string', description: 'Path to the PEM private key' },
      { flags: '--node-id', type: 'string', description: 'Stable node identifier (default: seed-<port>)' },
      { flags: '--cluster-id', type: 'string', description: 'Stable cluster identity (default: minted)' },
      { flags: '--join-token', type: 'string', description: 'Join token (default: minted)' },
      { flags: '--state', type: 'string', description: 'Directory for durable node state (incarnation)' },
      { flags: '--no-workloads', type: 'boolean', description: 'Run as a dedicated control plane: never a placement target' },
    ],
  },
  run: async function runClusterStart(input, ctx) {
    const opts = input as Record<string, string | undefined>;
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error('cluster start: --port is required and must be a positive integer');
    }
    if (opts.cert === undefined || opts.key === undefined) {
      throw new Error('cluster start: --cert and --key are required (WebTransport needs TLS)');
    }
    await startCluster({
      port,
      hostname: opts.hostname,
      nodeId: opts['node-id'],
      clusterId: opts['cluster-id'],
      joinToken: opts['join-token'] ?? mintToken(),
      stateDir: opts.state,
      ...(opts['no-workloads'] === true || opts['no-workloads'] === 'true'
        ? { acceptWorkloads: false }
        : {}),
      tls: { cert: opts.cert, key: opts.key },
    });
    await print(`cluster started on port ${port}\n`);
    await print(`join with: fino cluster join '${clusterJoinString()}'\n`);
    await untilAborted(ctx.signal);
    await drainAndLeave();
  },
});

/**
 * The SIGTERM contract: offload movable work, report what happened, then
 * leave. A failed drain still leaves — shutdown must not hang on it.
 */
async function drainAndLeave(): Promise<void> {
  try {
    const report = await drainCluster();
    await print(
      `drained: ${report.shed} workload(s) moved to peers, ${report.failed} failed at deadline, ` +
        `${report.remaining.active + report.remaining.parkedLive} live workload(s) exiting with this node\n`,
    );
  } catch (err) {
    await print(`drain failed: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    leaveCluster();
  }
}

const joinCommand = new Task({
  name: 'join',
  description: 'Join an existing cluster using a join string',
  outputMode: 'text',
  cli: {
    options: [
      { flags: '--node-id', type: 'string', description: 'Stable node identifier (default: minted)' },
      { flags: '--state', type: 'string', description: 'Directory for durable node state (incarnation)' },
      {
        flags: '--peer-port',
        type: 'string',
        description: 'UDP port for direct peer sessions (default: ephemeral)',
      },
      {
        flags: '--seed-relay',
        type: 'boolean',
        description: 'Do not listen for direct peer sessions; relay all traffic through the seed',
      },
    ],
    positionals: [
      { name: 'joinString', type: 'string', description: 'Join string printed by `cluster start`' },
    ],
  },
  run: async function runClusterJoin(input, ctx) {
    const opts = input as {
      joinString?: string;
      'node-id'?: string;
      state?: string;
      'peer-port'?: string;
      'seed-relay'?: boolean;
    };
    if (opts.joinString === undefined) {
      throw new Error('cluster join: a join string is required');
    }
    await joinCluster({
      joinString: opts.joinString,
      nodeId: opts['node-id'],
      stateDir: opts.state,
      peerListener: opts['seed-relay'] === true
        ? false
        : opts['peer-port'] !== undefined
          ? { port: Number(opts['peer-port']) }
          : undefined,
    });
    const client = getCluster();
    const cluster = client?.clusterId != null ? ` cluster ${client.clusterId}` : '';
    await print(`joined${cluster} as ${client?.nodeId}\n`);
    await untilAborted(ctx.signal);
    await drainAndLeave();
  },
});

function membershipTask(name: string, description: string): Task {
  return new Task({
    name,
    description,
    outputMode: 'text',
    cli: {
      positionals: [
        { name: 'joinString', type: 'string', description: 'Join string printed by `cluster start`' },
      ],
    },
    run: runClusterStatus,
  });
}

async function runClusterStatus(input: unknown): Promise<void> {
    const opts = input as { joinString?: string };
    if (opts.joinString === undefined) {
      throw new Error('cluster status: a join string is required');
    }
    const info = parseJoinString(opts.joinString);
    const nodeId = `observer-${Math.random().toString(36).slice(2, 9)}`;
    const transport = new WebTransportWorkerTransport(nodeId);
    await transport.connect(info.seed, sampleNodeLoad(), {
      ...(info.token !== undefined ? { token: info.token } : {}),
      observer: true,
      serverCertificateHashes: info.certHashes.map((hex) => ({
        algorithm: 'sha-256',
        value: hexToBytes(hex),
      })),
    });
    const client = new ClusterClient(transport, nodeId);
    client.start();
    try {
      await client.ready();
      if (client.clusterId !== null && client.clusterId !== info.clusterId) {
        throw new Error(
          `cluster status: reached cluster "${client.clusterId}" but the join string names "${info.clusterId}"`,
        );
      }
      const rows = client.peers;
      await print(`cluster ${client.clusterId ?? info.clusterId}\n`);
      if (rows.length === 0) {
        await print('no members\n');
      }
      for (const peer of rows) {
        // Load is only meaningful against capacity: 50% of 2 cores and of 64
        // cores are different amounts of headroom. Show the denominator when
        // the node reported one.
        const cores = peer.load.capacityCores;
        const cpu = `${(peer.load.cpu * 100).toFixed(0)}%${cores !== undefined ? ` of ${cores}c` : ''}`;
        const totalMemory = peer.load.capacityMemory;
        const memory =
          `${(peer.load.memory / (1024 * 1024)).toFixed(0)}MiB` +
          (totalMemory !== undefined ? `/${(totalMemory / (1024 * 1024 * 1024)).toFixed(0)}GiB` : '');
        const idle =
          peer.load.loopIdle !== undefined
            ? ` loop-idle ${(peer.load.loopIdle * 100).toFixed(0)}%`
            : '';
        // Queue depth is the balancer's input and the operator's earliest
        // warning: pending specs are work that has nowhere to run yet.
        const pending = peer.load.pendingSpecs ?? 0;
        const active = peer.load.activeWorkloads ?? 0;
        const queue = ` queue ${pending} pending / ${active} active`;
        // Whether the node advertises a directly dialable endpoint — not
        // whether a session is currently open, which only the two ends know.
        // Say "dialable" rather than "mesh" so this cannot be read as proof
        // that traffic is bypassing the seed; a cluster where every node says
        // seed-relay definitely is not.
        const path = peer.endpoint !== undefined ? '  dialable' : '  seed-relay';
        const draining = peer.load.draining === true ? '  [draining]' : '';
        await print(`${peer.nodeId}  cpu ${cpu}  rss ${memory}${idle}${queue}${path}${draining}\n`);
      }
    } finally {
      client.stop();
    }
}

const deployCommand = new Task({
  name: 'deploy',
  description: 'Pack an application, upload it, and run it on the cluster',
  outputMode: 'text',
  cli: {
    options: [
      { flags: '--name', type: 'string', description: 'Deployment name (default: directory basename)' },
      { flags: '--entry', type: 'string', description: 'Entry module relative to the app directory (default: main.ts)' },
      { flags: '--version', type: 'string', description: 'Informational version string' },
      { flags: '--replicas', type: 'string', description: 'Active-active replica count (default: 1)' },
      { flags: '--node-id', type: 'string', description: 'Deployer node identifier (default: minted)' },
    ],
    positionals: [
      { name: 'joinString', type: 'string', description: 'Join string printed by `cluster start`' },
      { name: 'dir', type: 'string', description: 'Application directory to deploy' },
    ],
  },
  run: async function runClusterDeploy(input) {
    const opts = input as Record<string, string | undefined> & { joinString?: string; dir?: string };
    if (opts.joinString === undefined || opts.dir === undefined) {
      throw new Error('cluster deploy: a join string and an application directory are required');
    }
    const dir = opts.dir.replace(/\/+$/, '');
    const name = opts.name ?? dir.split('/').pop()!;
    const entry = opts.entry ?? 'main.ts';
    // Unique per invocation: concurrent deploys of the same directory must
    // not collide on the archive path.
    const caskPath = `${dir}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.cask`;
    const replicas = opts.replicas === undefined ? undefined : Number(opts.replicas);
    if (replicas !== undefined && (!Number.isInteger(replicas) || replicas < 1)) {
      throw new Error('cluster deploy: --replicas must be a positive integer');
    }
    const packed = await packCask(dir, caskPath, {
      name,
      version: opts.version ?? '0.0.0',
      entry,
      ...(replicas === undefined ? {} : { replicas }),
    });
    await print(`packed ${name} as sha256-${packed.hash.slice(0, 12)}…\n`);

    await joinCluster({
      joinString: opts.joinString,
      nodeId: opts['node-id'],
      acceptWorkloads: false,
    });
    try {
      const client = getCluster()!;
      await client.uploadCask(caskPath);
      await print(`uploaded to the cluster store\n`);
      const port = new ClusterPort(`${client.nodeId}/p-deploy-${Date.now() % 1e6}`, client);
      const childPortId = await client.deployRemote(name, packed.hash, port.portId);
      await print(`deployed ${name} -> ${childPortId}\n`);
    } finally {
      leaveCluster();
    }
  },
});

const deploymentsCommand = new Task({
  name: 'deployments',
  description: 'Show deployment generation history',
  outputMode: 'text',
  cli: {
    positionals: [
      { name: 'joinString', type: 'string', description: 'Join string printed by `cluster start`' },
      { name: 'name', type: 'string', description: 'Limit to one deployment name' },
    ],
  },
  run: async function runClusterDeployments(input) {
    const opts = input as { joinString?: string; name?: string };
    if (opts.joinString === undefined) {
      throw new Error('cluster deployments: a join string is required');
    }
    await joinCluster({ joinString: opts.joinString, acceptWorkloads: false });
    try {
      const records = await getCluster()!.listDeployments(opts.name);
      if (records.length === 0) {
        await print('no deployments\n');
        return;
      }
      for (const record of records) {
        const when = new Date(record.createdAt).toISOString();
        await print(
          `${record.name}  gen ${record.generation}  ${record.state.padEnd(10)}  sha256-${record.caskHash.slice(0, 12)}…  ${when}\n`,
        );
      }
    } finally {
      leaveCluster();
    }
  },
});

const rollbackCommand = new Task({
  name: 'rollback',
  description: 'Roll a deployment back one generation and run it',
  outputMode: 'text',
  cli: {
    positionals: [
      { name: 'joinString', type: 'string', description: 'Join string printed by `cluster start`' },
      { name: 'name', type: 'string', description: 'Deployment name to roll back' },
    ],
  },
  run: async function runClusterRollback(input) {
    const opts = input as { joinString?: string; name?: string };
    if (opts.joinString === undefined || opts.name === undefined) {
      throw new Error('cluster rollback: a join string and a deployment name are required');
    }
    await joinCluster({ joinString: opts.joinString, acceptWorkloads: false });
    try {
      const client = getCluster()!;
      const port = new ClusterPort(`${client.nodeId}/p-rollback-${Date.now() % 1e6}`, client);
      const childPortId = await client.rollbackRemote(opts.name, port.portId);
      const active = (await client.listDeployments(opts.name)).find((r) => r.state === 'active');
      await print(
        `rolled back ${opts.name} to sha256-${active?.caskHash.slice(0, 12) ?? '?'}… (gen ${active?.generation ?? '?'}) -> ${childPortId}\n`,
      );
    } finally {
      leaveCluster();
    }
  },
});

const statusCommand = membershipTask('status', 'Show cluster membership and load without joining');
const nodesCommand = membershipTask('nodes', 'List cluster nodes and their load without joining');


/**
 * The `fino cluster` command: `start`, `join`, `status`, and `nodes`
 * subcommands over the `fino:cluster` API. Nodes started this way run no
 * entrypoint — they are pure runtime substrate until work is deployed to
 * them.
 */
const command = new Task({
  name: 'cluster',
  description: 'Start, join, and inspect a fino cluster',
  outputMode: 'text',
  run: async function runClusterCommand() {
    return 'usage: fino cluster <start|join|status|nodes>';
  },
  children: [
    startCommand,
    joinCommand,
    deployCommand,
    deploymentsCommand,
    rollbackCommand,
    statusCommand,
    nodesCommand,
  ],
});

export { command as default };
