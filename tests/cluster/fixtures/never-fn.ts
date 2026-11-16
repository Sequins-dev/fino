/**
 * Confirm that a remote call started, then remain pending until its worker dies.
 */
import { DiskFileSystem } from 'fino:file';

export default async function never(marker?: string): Promise<never> {
  if (marker !== undefined) await new DiskFileSystem().writeFile(marker, new Uint8Array());
  return new Promise<never>(() => {});
}
