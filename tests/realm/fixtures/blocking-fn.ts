export default function blockingCall(delayMs: number): number {
  const deadline = Date.now() + delayMs;
  while (Date.now() < deadline) {
    // Deliberately occupy one reactor pump for migration handoff testing.
  }
  return delayMs;
}
