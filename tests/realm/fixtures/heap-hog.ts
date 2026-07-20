// Grow old space steadily (yielding between slices) until the per-workload
// near-heap-limit containment terminates the realm.
const retained: Uint8Array[] = [];
async function hog(): Promise<void> {
  for (;;) {
    for (let i = 0; i < 24; i++) retained.push(new Uint8Array(1024 * 1024).fill(1));
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
void hog();
export default function size(): number {
  return retained.length;
}
