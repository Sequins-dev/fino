/**
* fino:net/http/transpile — zero-build TypeScript module serving.
*
* This middleware serves `.ts` and `.tsx` files as JavaScript ES modules using
* the runtime's OXC-backed `fino:format/typescript` transpiler. It is intended
* for small browser-side modules in Fino apps that do not need a bundler.
*
* The middleware only strips TypeScript syntax. It does not bundle imports,
* rewrite package specifiers, minify, or hide source code. Paths are resolved
* inside the configured root and traversal attempts are rejected.
*
* ```ts no_run
* import { App } from 'fino:net/http/app';
* import { transpileFiles } from 'fino:net/http/transpile';
*
* const app = new App();
* app.use(transpileFiles('./client', { prefix: '/client/' }));
* ```
*/
import { DiskFileSystem } from 'fino:file';
import { join, normalize } from 'fino:file/path';
import { transpile } from 'fino:format/typescript';
import { defineMiddleware, type Middleware } from 'fino:net/http/app';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  code: string;
}

export interface TranspileFilesOptions {
  /** URL path prefix to serve from. Defaults to `/`. */
  prefix?: string;
}

function requestPath(req: Request): string {
  const trusted = (req as Request & { _trustedPath?: () => string | null })._trustedPath?.();
  const path = trusted ?? new URL(req.url).pathname;
  const query = path.indexOf('?');
  return query < 0 ? path : path.slice(0, query);
}

function isTypeScriptPath(path: string): boolean {
  return path.endsWith('.ts') || path.endsWith('.tsx');
}

/**
* Serve TypeScript files under `root` as browser-loadable JavaScript modules.
*/
export function transpileFiles(root: string, opts: TranspileFilesOptions = {}): Middleware {
  const prefix = opts.prefix ?? '/';
  const fs = new DiskFileSystem();
  const cache = new Map<string, CacheEntry>();
  return defineMiddleware(async (ctx, next) => {
    const pathname = requestPath(ctx.request);
    if (!pathname.startsWith(prefix)) return next();
    const rawRelative = pathname.slice(prefix.length).replace(/^\/+/, '');
    if (!isTypeScriptPath(rawRelative)) return next();
    const decoded = decodeURIComponent(rawRelative);
    const normalized = normalize(decoded).toString();
    if (normalized.startsWith('..') || normalized.includes('/../')) return new Response('Forbidden', { status: 403 });
    const file = join(root, normalized).toString();
    let stat;
    try {
      stat = await fs.stat(file);
      if (!stat.isFile()) return next();
    } catch {
      return next();
    }
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return new Response(cached.code, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
    }
    const handle = await fs.open(file);
    try {
      const source = await handle.text();
      const result = transpile(source, {
        filename: file,
        sourceType: file.endsWith('.tsx') ? 'tsx' : 'ts'
      });
      if (!result.ok) return new Response(result.errors.map((error) => error.message).join('\n'), { status: 500 });
      cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, code: result.code });
      return new Response(result.code, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
    } finally {
      handle.close();
    }
  });
}
