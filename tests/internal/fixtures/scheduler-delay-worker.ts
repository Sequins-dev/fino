import { delay } from 'internal:scheduler/ops';

export default async function schedulerDelayWorker(request: {
  data: { ms: number };
}): Promise<{
  result: 'idle';
  costMicros: number;
}> {
  await delay(request.data.ms);
  return {
    result: 'idle',
    costMicros: request.data.ms
  };
}
