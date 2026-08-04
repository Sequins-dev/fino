/** Tries to allocate shared memory, which a simulation must refuse. */
export default async function main(): Promise<string> {
  try {
    const sab = new SharedArrayBuffer(64);
    return `allocated ${String(sab.byteLength)}`;
  } catch (err) {
    return String((err as Error).message);
  }
}
