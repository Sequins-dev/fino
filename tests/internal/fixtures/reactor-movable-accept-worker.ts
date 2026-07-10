import { DiskFileSystem } from 'fino:file';
import { Socket } from 'fino:net/socket';

export default async function movableAcceptWorker(request: {
  data: { addressPath: string; outputPath: string };
}) {
  const fs = new DiskFileSystem();
  const listener = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
  const address = listener.address as { family: 'ipv4'; ip: string; port: number };
  await fs.writeFile(request.data.addressPath, new TextEncoder().encode(String(address.port)));
  const socket = await listener.accept();
  if (socket === null) throw new Error('listener closed before accept');
  const [reader] = socket.split();
  let message = '';
  for await (const chunk of reader) message += new TextDecoder().decode(chunk);
  await fs.writeFile(request.data.outputPath, new TextEncoder().encode(message));
  reader.close();
  listener.close();
  return { result: 'terminated', costMicros: 1 };
}
