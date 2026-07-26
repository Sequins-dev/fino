import { describe, it } from 'fino:test/test';
import {
  cleanupProcess,
  collect,
  configuredNodeQuicAvailable,
  parseReadyAddress,
  spawnFino,
  spawnNodeQuic,
  withTimeout,
} from './fixtures/quic/interop-harness.ts';
type NodeInteropScenario =
  | 'h3'
  | 'echo'
  | 'datagram'
  | 'resume'
  | 'keyupdate'
  | 'large'
  | 'retry'
  | 'alpn-mismatch';
function expectedReply(peer: 'node' | 'fino', scenario: NodeInteropScenario): string {
  if (scenario === 'large') return `client h3 ${peer}:h3:1048576:1048576`;
  if (scenario === 'alpn-mismatch') return `client alpn-mismatch failed`;
  return `client h3 ${peer}:h3:${scenario === 'h3' ? 'from-fino' : scenario}`;
}
async function runScenario(t: any, scenario: NodeInteropScenario): Promise<void> {
  const nodeBin = await configuredNodeQuicAvailable();
  if (nodeBin === null) {
    t.ok(
      true,
      'NODE_QUIC_BIN is not configured or does not expose node:quic; Node QUIC interop skipped',
    );
    return;
  }
  const expectedNodeReply = expectedReply('node', scenario);
  const expectedFinoReply = expectedReply('fino', scenario);
  const nodeServer = spawnNodeQuic(nodeBin, 'tests/net/fixtures/quic-node-server.mjs', [
    `--scenario=${scenario}`,
  ]);
  const nodeServerWait = nodeServer.wait();
  let nodeServerOutText = '';
  let nodeReadyResolve!: (address: { port: number }) => void;
  const nodeReady = new Promise<{
    port: number;
  }>((resolve) => {
    nodeReadyResolve = resolve;
  });
  const nodeServerOut = collect(nodeServer.stdout, (text) => {
    nodeServerOutText += text;
    const address = parseReadyAddress(nodeServerOutText);
    if (address !== null) nodeReadyResolve(address);
  });
  const nodeServerErr = collect(nodeServer.stderr);
  try {
    const address = await withTimeout(nodeReady, 5e3, 'Node QUIC server readiness');
    const finoClient = spawnFino('tests/net/fixtures/quic-node-fino-client.ts', [
      String(address.port),
      `--scenario=${scenario}`,
    ]);
    const finoClientOut = collect(finoClient.stdout);
    const finoClientErr = collect(finoClient.stderr);
    const finoClientStatus = await withTimeout(
      finoClient.wait(),
      1e4,
      'Fino client to Node server',
    );
    t.equal(finoClientStatus.code, 0, await finoClientErr);
    t.equal(
      (await finoClientOut).trim(),
      expectedNodeReply,
      `Fino client completes ${scenario} scenario with Node server`,
    );
    if (scenario !== 'alpn-mismatch')
      await withTimeout(nodeServerWait, 1e4, 'Node QUIC server exit');
  } finally {
    await cleanupProcess(nodeServer, nodeServerWait);
    await nodeServerOut;
    await nodeServerErr;
  }
  const finoServer = spawnFino('tests/net/fixtures/quic-node-fino-server.ts', [
    `--scenario=${scenario}`,
  ]);
  const finoServerWait = finoServer.wait();
  let finoServerOutText = '';
  let finoReadyResolve!: (address: { port: number }) => void;
  const finoReady = new Promise<{
    port: number;
  }>((resolve) => {
    finoReadyResolve = resolve;
  });
  const finoServerOut = collect(finoServer.stdout, (text) => {
    finoServerOutText += text;
    const address = parseReadyAddress(finoServerOutText);
    if (address !== null) finoReadyResolve(address);
  });
  const finoServerErr = collect(finoServer.stderr);
  try {
    const address = await withTimeout(finoReady, 5e3, 'Fino QUIC server readiness');
    const nodeClient = spawnNodeQuic(nodeBin, 'tests/net/fixtures/quic-node-client.mjs', [
      String(address.port),
      `--scenario=${scenario}`,
    ]);
    const nodeClientOut = collect(nodeClient.stdout);
    const nodeClientErr = collect(nodeClient.stderr);
    const nodeClientStatus = await withTimeout(
      nodeClient.wait(),
      1e4,
      'Node client to Fino server',
    );
    t.equal(nodeClientStatus.code, 0, await nodeClientErr);
    t.equal(
      (await nodeClientOut).trim(),
      expectedFinoReply,
      `Node client completes ${scenario} scenario with Fino server`,
    );
    if (scenario !== 'alpn-mismatch') {
      const finoServerStatus = await withTimeout(finoServerWait, 1e4, 'Fino QUIC server exit');
      t.equal(finoServerStatus.code, 0, await finoServerErr);
    }
    if (scenario !== 'alpn-mismatch') await finoServerOut;
  } finally {
    await cleanupProcess(finoServer, finoServerWait);
    await finoServerErr;
  }
}
describe('QUIC Node interop', () => {
  it('exchanges raw h3 streams with Node QUIC when configured', async (t) => {
    await runScenario(t, 'h3');
  });
  it('exchanges echo streams with Node QUIC when configured', async (t) => {
    await runScenario(t, 'echo');
  });
  it('exchanges DATAGRAM scenario traffic with Node QUIC when configured', async (t) => {
    await runScenario(t, 'datagram');
  });
  it('exchanges resumed-session scenario traffic with Node QUIC when configured', async (t) => {
    await runScenario(t, 'resume');
  });
  it('exchanges key-update scenario traffic with Node QUIC when configured', async (t) => {
    await runScenario(t, 'keyupdate');
  });
  it('exchanges large raw h3 streams with Node QUIC when configured', async (t) => {
    await runScenario(t, 'large');
  });
  it('exchanges Retry scenario traffic with Node QUIC when configured', async (t) => {
    await runScenario(t, 'retry');
  });
  it('fails cleanly on ALPN mismatch with Node QUIC when configured', async (t) => {
    await runScenario(t, 'alpn-mismatch');
  });
});
