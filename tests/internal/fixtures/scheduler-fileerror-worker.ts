/**
* Reads a path that does not exist through its scheduler-owned `fino:file`
* provider, so the facade op fails; catches the rejection and writes the error
* message to a real path — proving a failed host op's error propagates back to
* tenant `await` with its message intact.
*/
import { DiskFileSystem } from 'fino:file';

export default async function schedulerFileErrorWorker(request: {
  data: { missingPath: string; outputPath: string };
}): Promise<{ result: string; costMicros: number }> {
  const fs = new DiskFileSystem();
  let message = 'no-error';
  try {
    await fs.readFile(request.data.missingPath);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  await fs.writeFile(request.data.outputPath, new TextEncoder().encode(message));
  return { result: 'terminated', costMicros: 1 };
}
