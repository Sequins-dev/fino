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
const variant = argv[4] ?? '';
const isWorkerTest = testPath.endsWith('.worker.js');
const workerImportScriptSources = new Map<
  string,
  {
    path: string;
    source: string;
  }
>();
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
  const href =
    typeof input === 'string'
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
        try {
          return new URL(href).pathname;
        } catch (_) {
          return null;
        }
      })();
  if (pathname === null || !/^\/interfaces\/[^/]+\.idl$/.test(pathname)) return null;
  return join(wptRoot, pathname.slice(1)).toString();
}
function localWptResourcePathFromFetchInput(input: unknown): string | null {
  const href =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input instanceof Request
          ? input.url
          : null;
  if (href === null || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) return null;
  try {
    const base = new URL(`http://web-platform.test/${testPath}${variant}`);
    const pathname = new URL(href, base).pathname;
    return join(wptRoot, pathname.slice(1)).toString();
  } catch (_) {
    return null;
  }
}
function installWorkerImportScripts(g: any): void {
  g.importScripts = (...specifiers: string[]) => {
    for (const specifier of specifiers) {
      if (specifier === '/resources/testharness.js') continue;
      const loaded = workerImportScriptSources.get(specifier);
      if (loaded === undefined)
        throw new Error(`unsupported worker importScripts specifier: ${specifier}`);
      (0, eval)(loaded.source + `\n//# sourceURL=${loaded.path}`);
    }
  };
}
function installBaseGlobals(): void {
  const g = globalThis as any;
  if (g.self === undefined) g.self = globalThis;
  if (!isWorkerTest && g.window === undefined) g.window = globalThis;
  if (g.Window === undefined) g.Window = function Window() {};
  if (g.GLOBAL === undefined) {
    g.GLOBAL = {
      isWindow: () => !isWorkerTest,
      isWorker: () => isWorkerTest,
      isShadowRealm: () => false,
    };
  }
  if (isWorkerTest) {
    installWorkerImportScripts(g);
    if (g.FileReaderSync === undefined)
      g.FileReaderSync = g[Symbol.for('fino.internal.FileReaderSync')];
    delete g.fetchLater;
    delete g.FetchLaterResult;
  }
  if (g.location === undefined) {
    const scheme = /\.https(?:\.|$)/.test(testPath) ? 'https' : 'http';
    const url = new URL(`${scheme}://web-platform.test/${testPath}${variant}`);
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
      toString() {
        return this.href;
      },
      valueOf() {
        return this.href;
      },
    };
  }
  if (g.navigator === undefined) g.navigator = {};
  if (g.navigator.platform === undefined) g.navigator.platform = '';
  const nativeFetch = g.fetch.bind(g);
  g.fetch = async function fetch(input: unknown, init?: RequestInit) {
    const localInterfacePath = interfacePathFromFetchInput(input);
    if (localInterfacePath !== null) {
      return new Response(await fs.readFile(localInterfacePath), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    const localResourcePath = localWptResourcePathFromFetchInput(input);
    if (localResourcePath !== null) {
      return new Response(await fs.readFile(localResourcePath), {
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
function discoverWorkerImportScripts(source: string): string[] {
  const scripts: string[] = [];
  const callPattern = /\bimportScripts\s*\(([^)]*)\)/g;
  let callMatch: RegExpExecArray | null;
  while ((callMatch = callPattern.exec(source)) !== null) {
    const args = callMatch[1]!;
    const stringPattern = /(['"])((?:\\.|(?!\1)[\s\S])*)\1/g;
    let stringMatch: RegExpExecArray | null;
    while ((stringMatch = stringPattern.exec(args)) !== null) {
      scripts.push(stringMatch[2]!.replace(/\\(['"\\])/g, '$1'));
    }
  }
  return scripts;
}
async function preloadWorkerImportScripts(basePath: string, source: string): Promise<void> {
  if (!isWorkerTest) return;
  for (const specifier of discoverWorkerImportScripts(source)) {
    if (specifier === '/resources/testharness.js' || workerImportScriptSources.has(specifier))
      continue;
    const path = scriptPath(basePath, specifier);
    workerImportScriptSources.set(specifier, {
      path,
      source: await fs.readFile(path),
    });
  }
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
  combined += await sourceForEval(basePath, source);
  const testAbsolutePath = join(wptRoot, basePath).toString();
  (0, eval)(combined + `\n//# sourceURL=${testAbsolutePath}`);
}
async function sourceForEval(basePath: string, source: string): Promise<string> {
  if (!/\.html$/.test(basePath)) return source;
  const scripts: string[] = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const attrs = match[1]!;
    const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/.exec(attrs);
    if (srcMatch !== null) {
      const specifier = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3]!;
      if (
        specifier === '/resources/testharness.js' ||
        specifier === '/resources/testharnessreport.js'
      )
        continue;
      const path = scriptPath(basePath, specifier);
      scripts.push(await fs.readFile(path));
      continue;
    }
    scripts.push(match[2]!);
  }
  if (scripts.length === 0) throw new Error(`WPT HTML file has no inline scripts: ${basePath}`);
  return scripts.join('\n');
}
function requiresWptServer(basePath: string, source: string): boolean {
  if (basePath === 'fetch/api/response/response-consume.html') return false;
  if (basePath.startsWith('urlpattern/')) return false;
  if (
    basePath === 'url/url-constructor.any.js' ||
    basePath === 'url/url-origin.any.js' ||
    basePath === 'url/url-setters.any.js'
  )
    return false;
  return (
    /\bfetch\s*\(\s*['"`]\//.test(source) ||
    /\bfetch\s*\(\s*['"`](?:resources\/|\.{1,2}\/)/.test(source) ||
    /\bnew\s+XMLHttpRequest\b/.test(source) ||
    /\/fetch\/api\/resources\//.test(source)
  );
}
function decodeManifestName(name: string): string {
  return name
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\0/g, '\0');
}
function nameTokens(name: string): string[] {
  return [...name.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0]!.toLowerCase());
}
function orderedTokenMatch(expected: string, actual: string): boolean {
  const expectedTokens = nameTokens(expected);
  if (expectedTokens.length < 2) return false;
  const actualTokens = nameTokens(actual);
  let cursor = 0;
  for (const token of expectedTokens) {
    const found = actualTokens.indexOf(token, cursor);
    if (found < 0) return false;
    cursor = found + 1;
  }
  return true;
}
function selectResults(results: HarnessResult[], requested: string | null): HarnessResult[] {
  if (requested === null) return results;
  const decoded = decodeManifestName(requested);
  let selected = results.filter((result) => result.name === requested || result.name === decoded);
  if (selected.length > 0) return selected;
  selected = results.filter((result) => orderedTokenMatch(decoded, result.name));
  return selected;
}
async function assertWptServerReady(): Promise<void> {
  try {
    const response = await fetch('http://web-platform.test:8000/');
    await response.arrayBuffer();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      [
        'This WPT file requires the upstream WPT server.',
        'Run `./third_party/wpt/wpt serve --no-h2` and complete WPT host setup first.',
        'WPT host setup must map web-platform.test and its subdomains to loopback in /etc/hosts.',
        'See https://web-platform-tests.org/running-tests/from-local-system.html#system-setup',
        `Preflight failure: ${detail}`,
      ].join('\n'),
    );
  }
}
async function main(): Promise<void> {
  if (testPath.length === 0) throw new Error('missing WPT test path argument');
  installBaseGlobals();
  const harnessPath = join(wptRoot, 'resources/testharness.js').toString();
  const testAbsolutePath = join(wptRoot, testPath).toString();
  const source = await fs.readFile(testAbsolutePath);
  await preloadWorkerImportScripts(testPath, source);
  let runnableSource = source;
  for (const script of discoverMetaScripts(source)) {
    runnableSource += '\n' + (await fs.readFile(scriptPath(testPath, script)));
  }
  const results: HarnessResult[] = [];
  if (requiresWptServer(testPath, runnableSource)) {
    await assertWptServerReady();
  }
  await evalFile(harnessPath);
  const g = globalThis as any;
  if (typeof g.setup === 'function') g.setup({ explicit_done: true });
  if (
    typeof g.add_result_callback !== 'function' ||
    typeof g.add_completion_callback !== 'function'
  ) {
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
  const selected = selectResults(results, subtest);
  if (subtest === null && selected.length === 0) {
    print({
      path: testPath,
      subtest,
      status: 'fail',
      results,
      message: 'WPT file completed without reporting any subtests',
    });
  }
  if (subtest !== null && selected.length === 0) {
    print({
      path: testPath,
      subtest,
      status: 'fail',
      results,
      message: `WPT subtest not reported: ${subtest}`,
    });
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
