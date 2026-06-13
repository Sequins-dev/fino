import { argv } from 'fino:process';
import { QuicEndpoint } from 'fino:net/quic';

const enc = new TextEncoder();
const dec = new TextDecoder();
const port = Number(argv[2]);
const scenario = argv.find((arg) => arg.startsWith('--scenario='))?.slice('--scenario='.length) ?? 'h3';
if (!Number.isFinite(port) || port <= 0) throw new Error('missing Node server port');

const alpnProtocols = scenario === 'alpn-mismatch' ? ['fino-no-match'] : ['h3'];
const endpoint = new QuicEndpoint({ alpnProtocols });
try {
  let connection;
  try {
    connection = await endpoint.connect({
      address: { family: 'ipv4', ip: '127.0.0.1', port },
      serverName: 'localhost',
      alpnProtocols,
    });
  } catch (error) {
    if (scenario !== 'alpn-mismatch') throw error;
    console.log('client alpn-mismatch failed');
    throw null;
  }
  if (scenario === 'keyupdate') connection.initiateKeyUpdate();
  const stream = await connection.openBidirectionalStream();
  await stream.writer.write(scenario === 'large' ? new Uint8Array(1024 * 1024) : enc.encode(scenario === 'h3' ? 'from-fino' : scenario));
  await stream.writer.close();
  const data = await stream.reader.read();
  console.log(`client ${connection.alpnProtocol} ${dec.decode(data!)}`);
  await connection.close();
} catch (error) {
  if (error !== null) throw error;
} finally {
  await endpoint.close();
}
