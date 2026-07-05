import { readTextFile, writeTextFile, delay } from 'internal:scheduler/ops';

export default async function schedulerHostOpWorker(request: {
  data: {
    inputPath: string;
    outputPath: string;
    marker: string;
  };
}): Promise<{
  result: 'idle';
  costMicros: number;
}> {
  await delay(0);
  const input = await readTextFile(request.data.inputPath);
  await writeTextFile(request.data.outputPath, `${request.data.marker}:${input}`);
  return {
    result: 'idle',
    costMicros: input.length
  };
}
