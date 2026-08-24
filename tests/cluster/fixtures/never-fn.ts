/**
 * Confirm that a remote call started, then remain pending until its worker dies.
 *
 * The marker is optional: callers that only need "pending forever" call with
 * no argument. An earlier version wrote the marker unconditionally, and the
 * two no-argument callers each left a file literally named `undefined` in the
 * repository root (FIN-154).
 */
import { DiskFileSystem } from 'fino:file';

export default async function never(marker?: string): Promise<never> {
  if (marker !== undefined) await new DiskFileSystem().writeFile(marker, new Uint8Array());
  return new Promise<never>(() => {});
}
