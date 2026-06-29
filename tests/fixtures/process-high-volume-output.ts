/**
 * Fixture: write enough stdout and stderr data to exercise concurrent pipe
 * draining from Process.
 */

import { stderr, stdout } from 'fino:process';

const enc = new TextEncoder();
const out = stdout();
const err = stderr();
const count = 160;
const payload = 'x'.repeat(1024);

for (let i = 0; i < count; i++) {
  await out.write(enc.encode(`stdout:${i}:${payload}\n`));
  await err.write(enc.encode(`stderr:${i}:${payload}\n`));
}

await out.flush();
await err.flush();
