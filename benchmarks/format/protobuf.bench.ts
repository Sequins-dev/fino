/**
 * Benchmarks for fino:format/protobuf.
 */
import { bench } from 'fino:bench';
import { defineMessage } from 'fino:format/protobuf';

interface Load {
  cpu: number;
  memory: number;
}

interface Envelope {
  kind: number;
  source: string;
  target: string;
  sequence: bigint;
  load?: Load;
  payload: Uint8Array[];
}

const LoadMessage = defineMessage<Load>({
  cpu: { number: 1, type: 'double' },
  memory: { number: 2, type: 'double' },
});

const EnvelopeMessage = defineMessage<Envelope>({
  kind: { number: 1, type: 'enum' },
  source: { number: 2, type: 'string' },
  target: { number: 3, type: 'string' },
  sequence: { number: 4, type: 'uint64' },
  load: { number: 5, type: LoadMessage, optional: true },
  payload: { number: 6, type: 'bytes', repeated: true },
});

function message(parts: number, partSize: number): Envelope {
  return {
    kind: 10,
    source: 'node-a/p-parent',
    target: 'node-b/p-child',
    sequence: 42n,
    load: { cpu: 0.25, memory: 512 * 1024 * 1024 },
    payload: Array.from({ length: parts }, (_, index) =>
      new Uint8Array(partSize).fill(index & 0xff),
    ),
  };
}

const SMALL = message(1, 64);
const TRANSFERRED = message(4, 16 * 1024);
const SMALL_BYTES = EnvelopeMessage.encode(SMALL);
const TRANSFERRED_BYTES = EnvelopeMessage.encode(TRANSFERRED);

bench('encode', (b) => {
  b.measure('small cluster envelope', () => EnvelopeMessage.encode(SMALL));
  b.measure('four 16KiB payload parts', () => EnvelopeMessage.encode(TRANSFERRED));
});

bench('decode', (b) => {
  b.measure('small cluster envelope', () => EnvelopeMessage.decode(SMALL_BYTES));
  b.measure('four 16KiB payload parts', () => EnvelopeMessage.decode(TRANSFERRED_BYTES));
});
