---
weight: 18
---
# Process Guide

`fino:process` provides POSIX-oriented process metadata, stdio, signals, child
process spawning, and child sandbox requests. It is not Node's global `process`
object and does not install `globalThis.process`.

## Metadata And Stdio

```ts no_run
import { argv, cwd, env, stdout } from 'fino:process';

await stdout().write(new TextEncoder().encode(`${cwd()}: ${argv.join(' ')}\n`));
console.log(env.PATH);
```

Use these APIs for runtime argv, environment snapshots, current directory
management, process IDs, platform identifiers, and standard streams.

## Spawn Children

```ts no_run
import { Process } from 'fino:process';

const proc = new Process('/bin/echo', ['hello']);
for await (const chunk of proc.stdout) {
  console.log(new TextDecoder().decode(chunk));
}
const result = await proc.wait();
```

Child stdio is always parent-managed pipes. Environment values replace rather
than merge with inherited values when `env` is supplied. There is no shell
option, detached mode, IPC channel, uid/gid switching, or Windows behavior
contract in this baseline.

## Signals And Sandboxing

Signal helpers expose POSIX signal constants and subscription behavior. Child
sandbox options are capability-reported: inspect `Process.sandboxReport` after
construction to see what was actually enforced. `strict` mode fails closed when
no backend can enforce the requested policy; `bestEffort` is reporting-oriented
and is not a security boundary.
