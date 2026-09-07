/**
 * fino:test/sim cassette ownership and replay coverage.
 */
import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { simulated } from 'fino:test/sim';

const fs = new DiskFileSystem();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const GUEST = new URL('./fixtures/harness-guest.ts', import.meta.url).pathname;

function tempDir(name: string): string {
  return `/tmp/fino-test-sim-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function removeFile(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {}
}

function world(onCall: () => void = () => {}): Record<string, Record<string, unknown>> {
  const values = new Map<string, unknown>();
  return {
    'app:kv': {
      get: async (key: unknown) => {
        onCall();
        return values.get(String(key));
      },
      set: async (key: unknown, value: unknown) => {
        onCall();
        values.set(String(key), value);
      },
    },
  };
}

describe('fino:test/sim', { exclusive: true }, () => {
  it('records once and then replays the test-owned cassette', async (t) => {
    const directory = tempDir('record-replay');
    const cassette = `${directory}/record-replay.json`;
    try {
      const recorded = await simulated(t, {
        entry: GUEST,
        args: ['greeting', 'hello'],
        world: world(),
        cassetteDir: directory,
        cassetteName: 'record-replay',
      });
      t.ok(recorded.cassette !== undefined, 'the first run records transport traffic');
      t.ok((await fs.readFile(cassette)).byteLength > 0, 'the recording is written to disk');

      let liveCalls = 0;
      const replayed = await simulated(t, {
        entry: GUEST,
        args: ['greeting', 'hello'],
        world: world(() => liveCalls++),
        cassetteDir: directory,
        cassetteName: 'record-replay',
      });
      t.equal(replayed.result, recorded.result, 'the saved traffic determines the result');
      t.equal(liveCalls, 0, 'replay never invokes the live providers');
      t.equal(replayed.cassette, undefined, 'replay does not replace the recording');
    } finally {
      await removeFile(cassette);
      try {
        await fs.rmdir(directory);
      } catch {}
    }
  });

  it('derives a stable cassette name from the full test name', async (t) => {
    const directory = tempDir('derived-name');
    const cassette = `${directory}/fino-test-sim-derives-a-stable-cassette-name-from-the-full-test-name.json`;
    try {
      t.equal(
        t.name,
        'fino:test/sim > derives a stable cassette name from the full test name',
        'the context identifies the complete owning test',
      );
      await simulated(t, {
        entry: GUEST,
        args: ['key', 'value'],
        world: world(),
        cassetteDir: directory,
      });
      t.ok((await fs.readFile(cassette)).byteLength > 0);
    } finally {
      await removeFile(cassette);
      try {
        await fs.rmdir(directory);
      } catch {}
    }
  });

  it('does not hide a malformed existing cassette', async (t) => {
    const directory = tempDir('malformed');
    const cassette = `${directory}/malformed.json`;
    await fs.mkdir(directory);
    await fs.writeFile(cassette, encoder.encode('{not json'));
    try {
      await t.rejects(
        () =>
          simulated(t, {
            entry: GUEST,
            args: ['key', 'value'],
            world: world(),
            cassetteDir: directory,
            cassetteName: 'malformed',
          }),
        /JSON|position|property name/i,
      );
      t.equal(decoder.decode(await fs.readFile(cassette)), '{not json', 'the file is untouched');
    } finally {
      await removeFile(cassette);
      await fs.rmdir(directory);
    }
  });

  it('can bypass cassette storage for a live simulation', async (t) => {
    const directory = tempDir('disabled');
    let calls = 0;
    const report = await simulated(t, {
      entry: GUEST,
      args: ['key', 'value'],
      world: world(() => calls++),
      cassetteDir: directory,
      noCassette: true,
    });

    t.equal(report.result, 'value');
    t.equal(calls, 2, 'the live providers handle both calls');
    await t.rejects(() => fs.lstat(directory), /ENOENT/, 'storage is not touched');
  });
});
