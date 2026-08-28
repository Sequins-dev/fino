/**
 * internal:ai/acp/transport — ACP newline-delimited JSON over process stdio.
 *
 * This module owns framing and serialized writes only; JSON-RPC and ACP
 * lifecycle policy remain in their respective layers.
 */
import { stdin, stdout } from 'fino:process';
import type { Transport } from 'fino:jsonrpc';

async function* splitLines(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffered = '';
  for await (const chunk of source) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop()!;
    for (const line of lines) yield line.endsWith('\r') ? line.slice(0, -1) : line;
  }
  buffered += decoder.decode();
  if (buffered.length > 0) yield buffered;
}
/**
 * Create ACP newline-delimited JSON over process stdio.
 *
 * Writes are serialized and flushed. Reserve stdout for ACP diagnostics-free.
 */
export function acpStdioTransport(): Transport {
  const encoder = new TextEncoder();
  const input = stdin();
  const output = stdout();
  let writes = Promise.resolve();
  return {
    send(message: string): Promise<void> {
      writes = writes.then(async () => {
        await output.write(encoder.encode(`${message}\n`));
        await output.flush();
      });
      return writes;
    },
    receive: () => splitLines(input),
    close: () => input.close(),
  };
}
