/**
* Pool worker: returns a module-level random id plus timing marks.
* A fresh realm re-evaluates the module and produces a new id, so exclusive
* pools can prove per-call recycling; the timestamps prove sole occupancy.
*/
const instanceId = Math.random();
export default async function instanceInfo(delayMs = 0): Promise<{
  id: number;
  start: number;
  end: number;
}> {
  const start = Date.now();
  if (delayMs > 0) await new Promise<void>((res) => setTimeout(res, delayMs));
  return {
    id: instanceId,
    start,
    end: Date.now()
  };
}
