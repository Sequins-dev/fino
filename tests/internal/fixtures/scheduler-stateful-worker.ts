let dispatchCount = 0;

type WorkerData = {
  baseCost?: number;
  asyncDepth?: number;
  result?: 'idle' | 'runnable' | 'budget_yield' | 'terminated' | 'failed';
  terminateAt?: number;
};

export default async function schedulerStatefulWorker(request: {
  data?: WorkerData;
}): Promise<{
  result: 'idle' | 'runnable' | 'budget_yield' | 'terminated' | 'failed';
  costMicros: number;
}> {
  const data = request.data ?? {};
  dispatchCount++;
  for (let i = 0; i < (data.asyncDepth ?? 0); i++) {
    await Promise.resolve();
  }
  return {
    result: data.terminateAt === dispatchCount ? 'terminated' : data.result ?? 'idle',
    costMicros: (data.baseCost ?? 0) + dispatchCount
  };
}
