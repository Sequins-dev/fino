import { describe, it } from 'fino:test/test';
import { App } from 'fino:net/http/app';
import { transpileFiles } from 'fino:net/http/transpile';
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();

async function tempDir(): Promise<string> {
  const dir = `/tmp/fino-transpile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fs.mkdir(dir, 0o700);
  return dir;
}

describe('fino:net/http/transpile', () => {
  it('serves TypeScript modules as JavaScript and refreshes after mtime changes', async (t) => {
    const root = await tempDir();
    await fs.writeFile(`${root}/mod.ts`, 'export const value: number = 1;');
    const app = new App();
    app.use(transpileFiles(root, { prefix: '/src/' }));
    app.get('/src/:file', () => new Response('fallback'));

    const first = await app.handle(new Request('http://local/src/mod.ts')) as Response;
    t.equal(first.headers.get('content-type'), 'text/javascript; charset=utf-8');
    t.ok((await first.text()).includes('value = 1'), 'type annotations are stripped');

    await fs.writeFile(`${root}/mod.ts`, 'export const value: number = 2;');
    const second = await app.handle(new Request('http://local/src/mod.ts')) as Response;
    t.ok((await second.text()).includes('value = 2'), 'mtime invalidates cache');
  });

  it('rejects traversal and non-TypeScript paths', async (t) => {
    const root = await tempDir();
    await fs.writeFile(`${root}/mod.js`, 'export const value = 1;');
    const app = new App();
    app.use(transpileFiles(root, { prefix: '/src/' }));
    app.get('/src/:file', () => new Response('fallback'));

    const js = await app.handle(new Request('http://local/src/mod.js')) as Response;
    t.equal(await js.text(), 'fallback', 'non-TypeScript files fall through');

    const traversal = await app.handle(new Request('http://local/src/%2e%2e/secret.ts')) as Response;
    t.equal(traversal.status, 403, 'path traversal is rejected');
  });
});
