import { FdReader, FdWriter } from 'fino:stream';
import * as loop from 'internal:runtime/loop';
import * as socket from 'fino:net/socket';
export default async function readAfterReady(input: {
  fd: number;
  readIterations?: number;
  raceFd?: number;
  structuredValue?: unknown;
  write?: string;
}): Promise<unknown> {
  if (input.structuredValue !== undefined) return input.structuredValue;
  if (input.readIterations !== undefined) {
    let reads = 0;
    while (reads < input.readIterations) {
      await loop.readable(input.fd);
      const chunk = socket.recv(input.fd, 1);
      if (chunk === socket.EAGAIN) continue;
      if (chunk === null) throw new Error('socket closed during repeated reads');
      reads += chunk.byteLength;
    }
    return reads;
  }
  if (input.write !== undefined) {
    const bytes = new TextEncoder().encode(input.write);
    const writer = new FdWriter(input.fd, () => {});
    await writer.write(bytes);
    await writer.flush();
    return bytes.byteLength;
  }
  if (input.raceFd !== undefined) {
    const readers = [new FdReader(input.fd, () => {}), new FdReader(input.raceFd, () => {})];
    const bytes = await Promise.race(readers.map((reader) => reader.read()));
    if (bytes === null) throw new Error('raced socket closed before readiness');
    return new TextDecoder().decode(bytes);
  }
  const reader = new FdReader(input.fd, () => {});
  const bytes = await reader.read();
  if (bytes === null) throw new Error('socket closed before it became readable');
  return new TextDecoder().decode(bytes);
}
