/** CLI presentation serving, binding, and failure coverage. */
import { describe, it } from 'fino:test/test';
import slidesCommand from 'fino:commands/slides';
import { Process, execPath } from 'fino:process';
import * as loop from 'internal:runtime/loop';
import { parseRoot, runCli } from './cli-test-helpers.ts';

const deck = new URL('../fixtures/slides-deck.mdx', import.meta.url).pathname;

async function within<T>(promise: PromiseLike<T>, milliseconds = 10_000): Promise<T> {
  const timeout = loop.timeout(milliseconds);
  timeout.unref();
  try {
    return await Promise.race([
      promise,
      timeout.then(() => {
        throw new Error('slides command timed out');
      }),
    ]);
  } finally {
    timeout.cancel();
  }
}

async function withSlidesServer(
  options: string[],
  check: (audience: string, presenter: string) => Promise<void>,
): Promise<void> {
  const process = new Process(execPath, ['slides', deck, '--port', '0', ...options]);
  process.stdin.close();
  const waiting = process.wait();
  try {
    const decoder = new TextDecoder();
    const audienceLine = (await within(
      process.stdout.readUntil(new Uint8Array([10]), 4096),
    )) as Uint8Array | null;
    const presenterLine = (await within(
      process.stdout.readUntil(new Uint8Array([10]), 4096),
    )) as Uint8Array | null;
    if (audienceLine === null || presenterLine === null)
      throw new Error('slides command exited before reporting both URLs');
    const audience = decoder
      .decode(audienceLine)
      .trim()
      .replace(/^Audience:\s*/, '');
    const presenter = decoder
      .decode(presenterLine)
      .trim()
      .replace(/^Presenter:\s*/, '');
    await check(audience, presenter);
  } finally {
    try {
      process.kill();
    } catch {}
    await within(waiting);
  }
}

describe('CLI slides command', () => {
  it('appears in root help and documents host and port options', async (t) => {
    const root = await parseRoot(['--help']);
    const help = await parseRoot(['slides', '--help']);
    t.ok(root.includes('slides'), 'root lists the slides command');
    t.ok(help.includes('--host'), 'slides help describes the bind address');
    t.ok(help.includes('--port'), 'slides help describes the port');
  });

  it('serves a deck on localhost with audience and presenter routes', async (t) => {
    await withSlidesServer([], async (audience, presenter) => {
      t.ok(audience.startsWith('http://127.0.0.1:'), 'default bind is localhost');
      t.ok(presenter.endsWith('/_presenter'), 'presenter route is separate');
      const audiencePage = await within(fetch(audience));
      const presenterPage = await within(fetch(presenter));
      t.ok((await audiencePage.text()).includes('Markdown can be'));
      t.ok((await presenterPage.text()).includes('fino-presenter-shell'));
    });
  });

  it('honors an explicit host address', async (t) => {
    await withSlidesServer(['--host', '0.0.0.0'], async (audience) => {
      t.ok(audience.startsWith('http://0.0.0.0:'), 'reported URL uses the requested host');
      const page = await within(fetch(audience.replace('0.0.0.0', '127.0.0.1')));
      t.ok((await page.text()).includes('Markdown can be'));
    });
  });

  it('fails before serving when the deck cannot be loaded', async (t) => {
    const { result, stdout, stderr } = await runCli(['slides', 'missing.mdx']);
    t.equal(result.code, 1, 'missing deck exits nonzero');
    t.equal(stdout, '', 'missing deck does not announce a server');
    t.ok(stderr.includes('missing.mdx'), 'error identifies the deck');
  });

  it('rejects invalid host and port options before binding', async (t) => {
    for (const [name, args] of [
      ['host', ['--host', '']],
      ['port', ['--port', '65536']],
    ] as const) {
      const { result, stdout, stderr } = await runCli(['slides', deck, ...args]);
      t.equal(result.code, 1, `invalid ${name} exits nonzero`);
      t.equal(stdout, '', `invalid ${name} does not announce a server`);
      t.ok(stderr.includes(`--${name}`), `invalid ${name} identifies the option`);
    }
  });

  it('closes the listener when a programmatic command is aborted', async (t) => {
    const controller = new AbortController();
    let reportAudience!: (url: string) => void;
    const audience = new Promise<string>((resolve) => {
      reportAudience = resolve;
    });
    const running = slidesCommand.run(
      { deck, port: 0 },
      {
        signal: controller.signal,
        writer: {
          mode: 'text',
          writeText(chunk) {
            if (chunk.startsWith('Audience:'))
              reportAudience(chunk.slice('Audience:'.length).trim());
          },
        },
      },
    );
    try {
      const url = await within(audience);
      t.equal((await within(fetch(url))).status, 200, 'listener serves before cancellation');
      controller.abort();
      await within(running);
      let failed = false;
      try {
        await within(fetch(url));
      } catch {
        failed = true;
      }
      t.ok(failed, 'listener is closed after cancellation');
    } finally {
      controller.abort();
      await within(running);
    }
  });
});
