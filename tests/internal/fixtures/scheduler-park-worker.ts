export default async function schedulerParkWorker(request: {
  data: { awaitId: number };
}): Promise<{
  result: 'idle';
  costMicros: number;
}> {
  const awaitFor = (globalThis as unknown as {
    __finoSchedulerAwait(id: number): Promise<number>;
  }).__finoSchedulerAwait;
  const value = await awaitFor(request.data.awaitId);
  return {
    result: 'idle',
    costMicros: value
  };
}
