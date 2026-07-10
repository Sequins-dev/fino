export default async function movableTimerWorker(request: { delayMs?: number }) {
  await new Promise((resolve) => setTimeout(resolve, request.delayMs ?? 25));
  return { result: 'idle', completed: true };
}
