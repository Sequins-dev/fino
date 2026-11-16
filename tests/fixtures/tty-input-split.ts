import { stdin } from 'fino:process';
import { createTuiInput } from 'fino:tty/tui';
import { writeStdout } from 'fino:tty';
import type { BytesReadOptions } from '../../js/internal/stream.ts';

// Force separate read results without requiring the parent process to submit
// every continuation within the decoder's 25 ms Escape-disambiguation window.
const reader = stdin();
const read = reader.read.bind(reader);
const chunks: Uint8Array[] = [];
reader.read = async (options?: BytesReadOptions) => {
  if (chunks.length === 0) {
    const result = await read(options);
    if (result.done) return result;
    for (let index = 0; index < result.value.byteLength; index++) {
      chunks.push(result.value.slice(index, index + 1));
    }
  }
  return { done: false, value: chunks.shift()! };
};

const input = createTuiInput({ mouse: false });
await writeStdout('READY\r\n');
for (;;) {
  const event = await input.read();
  if (event === null || (event.type === 'key' && event.key === 'q')) break;
  if (event.type === 'key') await writeStdout('<' + event.key + '>\r\n');
}
input.close();
