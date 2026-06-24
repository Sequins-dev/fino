import { DiskFileSystem } from 'fino:file';
import { argv, cwd, exit } from 'fino:process';
import { dirname, join } from 'fino:file/path';

interface HarnessResult {
  name: string;
  status: number;
  message: string;
  stack: string;
}

interface ChildResult {
  path: string;
  subtest: string | null;
  status: 'ok' | 'fail';
  results: HarnessResult[];
  message?: string;
}

const fs = new DiskFileSystem();
const wptRoot = join(cwd(), 'third_party/wpt').toString();
const testPath = argv[2] ?? '';
const subtest = argv[3] === undefined || argv[3] === '' ? null : argv[3];

function print(result: ChildResult): never {
  console.log(JSON.stringify(result));
  exit(result.status === 'ok' ? 0 : 1);
}

function scriptPath(basePath: string, specifier: string): string {
  if (specifier === '/resources/WebIDLParser.js') {
    return join(wptRoot, 'resources/webidl2/lib/webidl2.js').toString();
  }
  if (specifier.startsWith('/')) return join(wptRoot, specifier.slice(1)).toString();
  return join(dirname(join(wptRoot, basePath).toString()).toString(), specifier).toString();
}

function interfacePathFromFetchInput(input: unknown): string | null {
  const href = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input instanceof Request
        ? input.url
        : null;
  if (href === null) return null;
  const pathname = href.startsWith('/')
    ? href
    : (() => {
        try { return new URL(href).pathname; } catch (_) { return null; }
      })();
  if (pathname === null || !/^\/interfaces\/[^/]+\.idl$/.test(pathname)) return null;
  return join(wptRoot, pathname.slice(1)).toString();
}

function installBaseGlobals(): void {
  const g = globalThis as any;
  if (g.self === undefined) g.self = globalThis;
  if (g.window === undefined) g.window = globalThis;
  if (g.Window === undefined) g.Window = function Window() {};
  if (g.GLOBAL === undefined) {
    g.GLOBAL = {
      isWindow: () => false,
      isWorker: () => false,
      isShadowRealm: () => false,
    };
  }
  if (g.location === undefined) {
    const scheme = /\.https(?:\.|$)/.test(testPath) ? 'https' : 'http';
    const url = new URL(`${scheme}://web-platform.test/${testPath}`);
    g.location = {
      href: url.href,
      origin: url.origin,
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      toString() { return this.href; },
      valueOf() { return this.href; },
    };
  }

  const nativeFetch = g.fetch.bind(g);
  g.fetch = async function fetch(input: unknown, init?: RequestInit) {
    const localInterfacePath = interfacePathFromFetchInput(input);
    if (localInterfacePath !== null) {
      return new Response(await fs.readFile(localInterfacePath), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return nativeFetch(input as any, init);
  };
  Object.defineProperty(g.fetch, 'length', {
    value: 1,
    configurable: true,
  });
}

function discoverMetaScripts(source: string): string[] {
  const scripts: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const match = /^\/\/\s*META:\s*script=(.*)$/.exec(line.trim());
    if (match !== null) scripts.push(match[1]!.trim());
  }
  return scripts;
}

async function evalFile(path: string): Promise<void> {
  const source = await fs.readFile(path);
  (0, eval)(source + `\n//# sourceURL=${path}`);
}

async function evalTestWithMetaScripts(basePath: string, source: string): Promise<void> {
  let combined = '';
  for (const script of discoverMetaScripts(source)) {
    const path = scriptPath(basePath, script);
    combined += await fs.readFile(path);
    combined += `\n//# sourceURL=${path}\n`;
  }
  combined += source;
  const testAbsolutePath = join(wptRoot, basePath).toString();
  (0, eval)(combined + `\n//# sourceURL=${testAbsolutePath}`);
}

function requiresWptServer(source: string): boolean {
  return /\bfetch\s*\(\s*['"`]\//.test(source)
      || /\bfetch\s*\(\s*['"`](?:resources\/|\.{1,2}\/)/.test(source)
      || /\bnew\s+XMLHttpRequest\b/.test(source)
      || /\/fetch\/api\/resources\//.test(source);
}

async function assertWptServerReady(): Promise<void> {
  try {
    const response = await fetch('http://web-platform.test:8000/');
    await response.arrayBuffer();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error([
      'This WPT file requires the upstream WPT server.',
      'Run `./third_party/wpt/wpt serve --no-h2` and complete WPT host setup first.',
      'WPT host setup must map web-platform.test and its subdomains to loopback in /etc/hosts.',
      'See https://web-platform-tests.org/running-tests/from-local-system.html#system-setup',
      `Preflight failure: ${detail}`,
    ].join('\n'));
  }
}

async function main(): Promise<void> {
  if (testPath.length === 0) throw new Error('missing WPT test path argument');
  installBaseGlobals();

  const harnessPath = join(wptRoot, 'resources/testharness.js').toString();
  const testAbsolutePath = join(wptRoot, testPath).toString();
  const source = await fs.readFile(testAbsolutePath);
  let runnableSource = source;
  for (const script of discoverMetaScripts(source)) {
    runnableSource += '\n' + await fs.readFile(scriptPath(testPath, script));
  }
  const results: HarnessResult[] = [];

  if (requiresWptServer(runnableSource)) {
    await assertWptServerReady();
  }

  await evalFile(harnessPath);
  const g = globalThis as any;
  if (typeof g.setup === 'function') g.setup({ explicit_done: true });
  if (typeof g.add_result_callback !== 'function' || typeof g.add_completion_callback !== 'function') {
    throw new Error('upstream testharness.js did not install result callbacks');
  }

  g.add_result_callback((test: any) => {
    results.push({
      name: String(test.name),
      status: Number(test.status),
      message: String(test.message ?? ''),
      stack: String(test.stack ?? ''),
    });
  });

  const completed = new Promise<void>((resolve) => {
    g.add_completion_callback(() => resolve());
  });

  await evalTestWithMetaScripts(testPath, source);
  if (typeof g.done === 'function') g.done();
  await completed;

  const selected = subtest === null ? results : results.filter((result) => result.name === subtest);
  if (subtest !== null && selected.length === 0) {
    print({ path: testPath, subtest, status: 'fail', results, message: `WPT subtest not reported: ${subtest}` });
  }
  const failures = selected.filter((result) => result.status !== 0);
  print({
    path: testPath,
    subtest,
    status: failures.length === 0 ? 'ok' : 'fail',
    results: selected,
    message: failures.map((result) => `${result.name}: ${result.message}`).join('\n') || undefined,
  });
}

main().catch((err) => {
  print({
    path: testPath,
    subtest,
    status: 'fail',
    results: [],
    message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
  });
});
