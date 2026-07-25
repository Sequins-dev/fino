const isolateId = Math.random().toString(36).slice(2);

export default async function scalingCall(delayMs: number): Promise<string> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  return isolateId;
}
