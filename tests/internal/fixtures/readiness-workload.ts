import { FdReader, FdWriter } from 'fino:stream';
export default async function readAfterReady(input: {
  fd: number;
  raceFd?: number;
  write?: string;
}): Promise<string | number> {
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
