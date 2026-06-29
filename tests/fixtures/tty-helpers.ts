import { readLine, writeStderr, writeStdout } from 'fino:tty';

const line = await readLine('prompt>');
await writeStdout(`stdout:${line ?? 'null'}\n`);
await writeStderr('stderr:ok\n');
