import { describe, it } from 'fino:test/test';
import { topic } from 'fino:context/topic';
import { DiskFileSystem } from 'fino:file';
import { AISandbox, type SandboxAuditEvent } from 'fino:ai/sandbox';
import { serveHttp } from 'fino:net/http/server';
import { processSandboxCapabilities } from 'fino:process';
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}
function strictProcessExecAvailable(): boolean {
  const capabilities = processSandboxCapabilities();
  const requiredFeature = capabilities.platform === 'linux' ? 'landlock' : 'macos-seatbelt';
  return capabilities.features.some(
    (feature) => feature.name === requiredFeature && feature.available,
  );
}
describe('AI sandbox', () => {
  it('denies ambient modules and network globals by default', async (t) => {
    const events: SandboxAuditEvent[] = [];
    const handle = topic<SandboxAuditEvent>('fino:ai/sandbox').subscribe((event) =>
      events.push(event),
    );
    const sandbox = new AISandbox(`
      export default async () => {
        let processModule = 'accessible';
        try {
          await import('fino:process');
        } catch {
          processModule = 'blocked';
        }
        return { processModule, fetchType: typeof globalThis.fetch };
      };
    `);
    try {
      t.deepEqual(await sandbox.call(), {
        processModule: 'blocked',
        fetchType: 'undefined',
      });
      t.ok(events.some((event) => event.capability === 'execute' && event.outcome === 'used'));
    } finally {
      sandbox.terminate();
      handle.dispose();
    }
  });
  it('exposes only explicitly granted environment variables and secrets', async (t) => {
    const events: SandboxAuditEvent[] = [];
    const handle = topic<SandboxAuditEvent>('fino:ai/sandbox').subscribe((event) =>
      events.push(event),
    );
    const sandbox = new AISandbox(
      `
      import { environment, secret } from 'fino:ai/sandbox/capabilities';
      export default async () => ({
        mode: await environment('MODE'),
        token: await secret('API_TOKEN'),
      });
    `,
      {
        environment: { MODE: 'test' },
        secrets: { API_TOKEN: 'super-secret' },
      },
    );
    try {
      t.deepEqual(await sandbox.call(), {
        mode: 'test',
        token: 'super-secret',
      });
      t.equal(
        JSON.stringify(events).includes('super-secret'),
        false,
        'audit events never include secret values',
      );
      await t.rejects(
        () =>
          new AISandbox(
            `
        import { environment } from 'fino:ai/sandbox/capabilities';
        export default () => environment('HOME');
      `,
            { environment: { MODE: 'test' } },
          ).call(),
        /not granted/i,
      );
    } finally {
      sandbox.terminate();
      handle.dispose();
    }
  });
  it('confines file reads to granted roots and audits use and denial', async (t) => {
    const fs = new DiskFileSystem();
    const root = `/tmp/fino-ai-sandbox-${Date.now()}`;
    await fs.mkdir(root);
    await fs.writeFile(`${root}/allowed.txt`, new TextEncoder().encode('allowed'));
    const events: SandboxAuditEvent[] = [];
    const handle = topic<SandboxAuditEvent>('fino:ai/sandbox').subscribe((event) =>
      events.push(event),
    );
    const sandbox = new AISandbox(
      `
      import { readText } from 'fino:ai/sandbox/capabilities';
      export default (path: string) => readText(path);
    `,
      { filesystem: { read: [root] } },
    );
    const deniedSandbox = new AISandbox(
      `
      import { readText } from 'fino:ai/sandbox/capabilities';
      export default (path: string) => readText(path);
    `,
      { filesystem: { read: [root] } },
    );
    try {
      t.equal(await sandbox.call(`${root}/allowed.txt`), 'allowed');
      const denied = await rejection(() => deniedSandbox.call('/etc/hosts'));
      t.ok(/not granted/i.test(String(denied)), `actionable denial: ${String(denied)}`);
      t.ok(
        events.some((event) => event.capability === 'filesystem.read' && event.outcome === 'used'),
      );
      t.ok(
        events.some(
          (event) => event.capability === 'filesystem.read' && event.outcome === 'denied',
        ),
      );
    } finally {
      sandbox.terminate();
      deniedSandbox.terminate();
      handle.dispose();
      await fs.unlink(`${root}/allowed.txt`);
      await fs.rmdir(root);
    }
  });
  it('writes only beneath an explicitly granted root', async (t) => {
    const fs = new DiskFileSystem();
    const root = `/tmp/fino-ai-sandbox-write-${Date.now()}`;
    await fs.mkdir(root);
    const sandbox = new AISandbox(
      `
      import { writeText } from 'fino:ai/sandbox/capabilities';
      export default (path: string) => writeText(path, 'written');
    `,
      { filesystem: { write: [root] } },
    );
    try {
      await sandbox.call(`${root}/output.txt`);
      t.equal(new TextDecoder().decode(await fs.readFile(`${root}/output.txt`)), 'written');
    } finally {
      sandbox.terminate();
      await fs.unlink(`${root}/output.txt`);
      await fs.rmdir(root);
    }
  });
  it('permits HTTP requests only to granted origins and methods', async (t) => {
    const server = serveHttp(
      { port: 0 },
      (request) => new Response(`${request.method}:${new URL(request.url).pathname}`),
    );
    const origin = `http://127.0.0.1:${server.port}`;
    const sandbox = new AISandbox(
      `
      import { fetchText } from 'fino:ai/sandbox/capabilities';
      export default (url: string) => fetchText(url);
    `,
      {
        network: {
          origins: [origin],
          methods: ['GET'],
        },
      },
    );
    try {
      const result = (await sandbox.call(`${origin}/allowed`)) as {
        status: number;
        body: string;
      };
      t.equal(result.status, 200);
      t.equal(result.body, 'GET:/allowed');
    } finally {
      sandbox.terminate();
      await server.close();
    }
  });
  it('fails closed for network and subprocess access without grants', async (t) => {
    const networkSandbox = new AISandbox(`
      import { fetchText } from 'fino:ai/sandbox/capabilities';
      export default () => fetchText('https://example.com/');
    `);
    const processSandbox = new AISandbox(`
      import { spawn } from 'fino:ai/sandbox/capabilities';
      export default () => spawn('/bin/echo', ['hello']);
    `);
    try {
      const networkDenied = await rejection(() => networkSandbox.call());
      t.ok(
        /network.*not granted/i.test(String(networkDenied)),
        `network denial: ${String(networkDenied)}`,
      );
      const processDenied = await rejection(() => processSandbox.call());
      t.ok(
        /subprocess.*not granted/i.test(String(processDenied)),
        `process denial: ${String(processDenied)}`,
      );
    } finally {
      networkSandbox.terminate();
      processSandbox.terminate();
    }
  });
  it('rejects non-HTTP URL schemes even when their opaque origin is granted', async (t) => {
    const sandbox = new AISandbox(
      `
      import { fetchText } from 'fino:ai/sandbox/capabilities';
      export default () => fetchText('data:text/plain,secret');
    `,
      { network: { origins: ['data:text/plain,allowed'] } },
    );
    try {
      const denied = await rejection(() => sandbox.call());
      t.ok(/http|scheme|protocol/i.test(String(denied)), `scheme denial: ${String(denied)}`);
    } finally {
      sandbox.terminate();
    }
  });
  it('enforces the operation budget across concurrent capability calls', async (t) => {
    const sandbox = new AISandbox(
      `
      import { environment } from 'fino:ai/sandbox/capabilities';
      export default () => Promise.all([environment('MODE'), environment('MODE')]);
    `,
      {
        environment: { MODE: 'test' },
        resources: { maxOperations: 1 },
      },
    );
    try {
      await t.rejects(() => sandbox.call(), /operation budget/i);
    } finally {
      sandbox.terminate();
    }
  });
  it('enforces the wall-clock budget for pending sandbox work', async (t) => {
    const sandbox = new AISandbox(
      `
      export default () => new Promise(() => {});
    `,
      { resources: { wallClockMs: 20 } },
    );
    try {
      const denied = await rejection(() => sandbox.call());
      t.ok(/exceeded 20ms/i.test(String(denied)), `wall-clock denial: ${String(denied)}`);
    } finally {
      sandbox.terminate();
    }
  });
  it('force-kills synchronous sandbox work after the wall-clock budget', async (t) => {
    const sandbox = new AISandbox(
      `
      export default () => {
        while (true) {}
      };
    `,
      { resources: { wallClockMs: 20 } },
    );
    const startedAt = Date.now();
    try {
      const denied = await rejection(() => sandbox.call());
      t.ok(/exceeded 20ms/i.test(String(denied)), `wall-clock denial: ${String(denied)}`);
      t.ok(Date.now() - startedAt < 2e3, 'busy child is killed promptly');
    } finally {
      sandbox.terminate();
    }
  });
  it('runs allowlisted subprocesses only through strict sandbox enforcement', async (t) => {
    const sandbox = new AISandbox(
      `
      import { spawn } from 'fino:ai/sandbox/capabilities';
      export default () => spawn('/bin/echo', ['hello']);
    `,
      { subprocess: { commands: ['/bin/echo'] } },
    );
    try {
      if (strictProcessExecAvailable()) {
        const result = (await sandbox.call()) as {
          code: number | null;
          stdout: string;
        };
        t.equal(result.code, 0);
        t.equal(result.stdout.trim(), 'hello');
      } else {
        const failedClosed = await rejection(() => sandbox.call());
        t.ok(
          /strict sandbox/i.test(String(failedClosed)),
          `strict subprocess sandbox fails closed without its platform mechanism: ${String(failedClosed)}`,
        );
      }
    } finally {
      sandbox.terminate();
    }
  });
  it('bounds combined subprocess stdout and stderr', async (t) => {
    const sandbox = new AISandbox(
      `
      import { spawn } from 'fino:ai/sandbox/capabilities';
      export default () => spawn('/bin/sh', ['-c', 'printf 1234; printf 5678 >&2']);
    `,
      {
        subprocess: { commands: ['/bin/sh'] },
        resources: { maxProcessOutputBytes: 6 },
      },
    );
    try {
      if (strictProcessExecAvailable()) {
        await t.rejects(() => sandbox.call(), /process output exceeds 6 bytes/i);
      } else {
        await t.rejects(
          () => sandbox.call(),
          /strict sandbox/i,
          'subprocess is rejected before execution when strict process-exec enforcement is unavailable',
        );
      }
    } finally {
      sandbox.terminate();
    }
  });
});
