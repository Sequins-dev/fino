export default async function schedulerIoWorker(request: {
  data: {
    inputText: string;
    expectText?: string;
    marker: string;
    result?: 'idle' | 'runnable' | 'budget_yield' | 'terminated' | 'failed';
    costMicros?: number;
  };
}): Promise<{
  result: 'idle' | 'runnable' | 'budget_yield' | 'terminated' | 'failed';
  costMicros: number;
  bytesRead: number;
}> {
  if (request.data.expectText !== undefined && request.data.inputText !== request.data.expectText) {
    return {
      result: 'failed',
      costMicros: 1,
      bytesRead: request.data.inputText.length
    };
  }
  return {
    result: request.data.result ?? 'idle',
    costMicros: request.data.costMicros ?? 1,
    bytesRead: request.data.inputText.length
  };
}
