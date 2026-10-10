/**
 * internal:ai/acp/transport — ACP newline-delimited JSON over process stdio.
 *
 * This module owns framing and serialized writes only; JSON-RPC and ACP
 * lifecycle policy remain in their respective layers.
 */
import { stdin, stdout } from 'fino:process';
import type { Transport } from 'fino:jsonrpc';
import { readLines } from 'internal:stream/text';

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
    receive: () => readLines(input, { fatal: true }),
    close: () => input.close(),
  };
}
