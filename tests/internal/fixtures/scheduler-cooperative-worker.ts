/**
* A well-behaved workload: it does a bounded slice of work and voluntarily
* yields (`budget_yield`), reporting its cost so the scheduler can account debt.
* It never runs synchronously past its budget, so the hard-budget watchdog never
* touches it — the cooperative counterpart to the runaway worker.
*/
export default async function schedulerCooperativeWorker(request: {
  budgetMicros?: number;
  data?: { costMicros?: number };
}): Promise<{ result: string; costMicros: number }> {
  const cost = request.data?.costMicros ?? request.budgetMicros ?? 100;
  return { result: 'budget_yield', costMicros: cost };
}
