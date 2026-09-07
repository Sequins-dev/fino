import { registerShutdownHook } from 'internal:shutdown';

type ParallelValue = {
  value: number;
  delayMs: number;
  stats: SharedArrayBuffer;
  gate?: SharedArrayBuffer;
  fail?: boolean;
};

type SharedWriter = {
  buffer: SharedArrayBuffer;
  byteOffset: number;
  byteCapacity: number;
  slot: number;
  sequence: number;
};

type WorkerContext = {
  batchIndex: number;
  epoch: number;
  workerId: number;
  shared?: SharedWriter;
};

function recordMaximum(stats: Int32Array, value: number): void {
  while (true) {
    const previous = Atomics.load(stats, 1);
    if (previous >= value || Atomics.compareExchange(stats, 1, previous, value) === previous)
      return;
  }
}

export default async function collate(
  values: Array<number | ParallelValue>,
  context: WorkerContext,
): Promise<
  number[] | { byteLength: number; items: Array<{ byteOffset: number; byteLength: number }> }
> {
  if (context.shared) {
    const numbers = values.map((value) => (typeof value === 'number' ? value : value.value));
    const output = new Uint32Array(
      context.shared.buffer,
      context.shared.byteOffset,
      numbers.length,
    );
    output.set(numbers);
    return {
      byteLength: output.byteLength,
      items: numbers.map((_, index) => ({
        byteOffset: index * Uint32Array.BYTES_PER_ELEMENT,
        byteLength: Uint32Array.BYTES_PER_ELEMENT,
      })),
    };
  }

  const parallel = values as ParallelValue[];
  const stats = new Int32Array(parallel[0]!.stats);
  if (stats.length > 2) {
    registerShutdownHook(() => {
      Atomics.add(stats, 2, 1);
    });
  }
  const active = Atomics.add(stats, 0, 1) + 1;
  recordMaximum(stats, active);
  try {
    if (parallel[0]!.gate) {
      await Atomics.waitAsync(new Int32Array(parallel[0]!.gate), 0, 0).value;
    } else {
      await new Promise((resolve) => setTimeout(resolve, parallel[0]!.delayMs));
    }
    if (parallel[0]!.fail) throw new Error(`worker-${parallel[0]!.value} failed`);
    return parallel.map((value) => value.value * 10);
  } finally {
    Atomics.sub(stats, 0, 1);
  }
}
