import { DiskFileSystem } from 'fino:file';
import { cwd, exit } from 'fino:process';
import { dirname, join, relative } from 'fino:file/path';
import { WPT_CATEGORIES } from './categories.mts';
import type { WptManifest, WptManifestEntry, WptManifestSubtest } from './manifest.mts';

const fs = new DiskFileSystem();
const root = join(cwd(), 'third_party/wpt').toString();
const outPath = join(cwd(), 'tests/integration/fixtures/wpt/manifest.generated.mts').toString();

function classify(path: string): string {
  if (path.endsWith('.any.js')) return '.any.js';
  if (path.endsWith('.worker.js')) return '.worker.js';
  if (path.endsWith('.window.js')) return '.window.js';
  if (path.endsWith('.https.html')) return '.https.html';
  if (path.endsWith('.html')) return '.html';
  if (path.endsWith('.js')) return '.js';
  return 'unknown';
}

function discoverMeta(source: string): { variants: string[]; scripts: string[]; globals: string[] } {
  const variants: string[] = [];
  const scripts: string[] = [];
  const globals: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const match = /^\/\/\s*META:\s*([^=]+)=(.*)$/.exec(line.trim());
    if (match === null) continue;
    const key = match[1]!.trim();
    const value = match[2]!.trim();
    if (key === 'variant') variants.push(value);
    if (key === 'script') scripts.push(value);
    if (key === 'global') globals.push(...value.split(',').map((part) => part.trim()).filter((part) => part.length > 0));
  }
  return { variants, scripts, globals };
}

function discoverSubtests(source: string): WptManifestSubtest[] {
  const subtests: WptManifestSubtest[] = [];
  const pattern = /\b(test|promise_test|async_test)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const kind = match[1] as WptManifestSubtest['kind'];
    const call = readCallArguments(source, pattern.lastIndex);
    if (call === null) continue;
    pattern.lastIndex = call.end;
    const name = readStringExpression(call.args[1] ?? '');
    if (name !== null) subtests.push({ kind, name });
  }
  return subtests;
}

function readCallArguments(source: string, start: number): { args: string[]; end: number } | null {
  const args: string[] = [];
  let argStart = start;
  let parenDepth = 1;
  let braceDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    else if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth--;

    if (parenDepth === 0) {
      args.push(source.slice(argStart, i).trim());
      return { args, end: i + 1 };
    }
    if (ch === ',' && parenDepth === 1 && braceDepth === 0 && bracketDepth === 0) {
      args.push(source.slice(argStart, i).trim());
      argStart = i + 1;
    }
  }
  return null;
}

function readStringExpression(expression: string): string | null {
  const parts: string[] = [];
  let rest = expression.trim();
  while (rest.length > 0) {
    const match = /^(['"`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(rest);
    if (match === null) return null;
    if (match[1] === '`' && /\$\{/.test(match[2]!)) return null;
    parts.push(decodeStringLiteral(match[2]!));
    rest = rest.slice(match[0].length).trim();
    if (rest.length === 0) break;
    if (!rest.startsWith('+')) return null;
    rest = rest.slice(1).trim();
  }
  return parts.length === 0 ? null : parts.join('');
}

function decodeStringLiteral(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\(['"`\\])/g, '$1');
}

function needsWptServer(source: string): boolean {
  return /\bfetch\s*\(\s*['"`]\//.test(source)
      || /\bfetch\s*\(\s*['"`](?:resources\/|\.{1,2}\/)/.test(source)
      || /\bfetch\s*\(\s*['"`](?![A-Za-z][A-Za-z0-9+.-]*:)/.test(source)
      || /\bfetch\s*\(\s*RESOURCES_DIR\b/.test(source)
      || /\bnew\s+EventSource\s*\(\s*['"`](?:resources\/|\.{1,2}\/|\/)/.test(source)
      || /\bRESOURCES_DIR\b/.test(source)
      || /\bget_host_info\s*\(/.test(source)
      || /\{\{host\}\}/.test(source)
      || /\bweb-platform\.test\b/.test(source)
      || /['"`]\.\.\/resources\//.test(source)
      || /['"`]\/media\//.test(source)
      || /\bfetch\s*\(\s*location\.href\b/.test(source)
      || /\bnew\s+XMLHttpRequest\b/.test(source)
      || /\/fetch\/api\/resources\//.test(source);
}

function resolveMetaScriptPath(basePath: string, specifier: string): string {
  if (specifier === '/resources/WebIDLParser.js') {
    return join(root, 'resources/webidl2/lib/webidl2.js').toString();
  }
  return specifier.startsWith('/')
    ? join(root, specifier.slice(1)).toString()
    : join(dirname(basePath).toString(), specifier).toString();
}

function runnableStatus(path: string, type: string, source: string, missingScripts: string[], metaGlobals: string[]): { runnable: boolean; reason: string | null } {
  if (path.includes('.sub.')) return { runnable: false, reason: 'requires WPT server .sub preprocessing' };
  if (missingScripts.length > 0) return { runnable: false, reason: `requires missing WPT META script ${missingScripts[0]}` };
  if (
    metaGlobals.length > 0 &&
    metaGlobals.every((global) => global !== 'window') &&
    metaGlobals.some((global) => /worker/i.test(global))
  ) {
    return { runnable: false, reason: 'requires Worker test environment' };
  }
  if (metaGlobals.length > 0 && metaGlobals.every((global) => global === 'window')) {
    return { runnable: false, reason: 'requires document/window navigation' };
  }
  if (/\/owning-type(?:-[^/]+)?\.tentative\.any\.js$/.test(path)) {
    return { runnable: false, reason: 'requires tentative ReadableStream type: "owning" transfer semantics' };
  }
  if (path === 'fetch/fetch-later/basic.https.window.js') {
    return { runnable: true, reason: null };
  }
  if (path === 'fetch/fetch-later/basic.https.worker.js' || path === 'FileAPI/blob/Blob-in-worker.worker.js') {
    return { runnable: true, reason: null };
  }
  if (path === 'WebCryptoAPI/derive_bits_keys/derived_bits_length.https.any.js') {
    return { runnable: false, reason: 'requires X25519 WebCrypto algorithm support for mixed deriveBits length subtests' };
  }
  if (path === 'WebCryptoAPI/historical.any.js') {
    return { runnable: false, reason: 'requires non-secure context WebCrypto global filtering' };
  }
  if (/\bcaches\b|\bCacheStorage\b|\bCache\b/.test(source)) {
    return { runnable: false, reason: 'requires Cache API globals, which Fino does not install' };
  }
  if (/\bFileReaderSync\b/.test(source)) return { runnable: false, reason: 'requires FileReaderSync global, which Fino does not install' };
  if (/\bFileReader\b/.test(source) && type !== '.any.js') {
    return { runnable: false, reason: 'requires FileReader in document or worker environment' };
  }
  if (/\bnew\s+Worker\s*\(|\bWorker\s*\(/.test(source)) return { runnable: false, reason: 'requires Worker global, which Fino does not install' };
  if (type === '.js') return { runnable: false, reason: 'standalone helper script, not a WPT test entry' };
  if (type === '.worker.js') return { runnable: false, reason: 'requires Worker test environment' };
  if (type === '.window.js' || type === '.html' || type === '.https.html') {
    return { runnable: false, reason: 'requires document/window navigation' };
  }
  if (needsWptServer(source)) return { runnable: false, reason: 'requires upstream WPT server and host setup' };
  if (type === '.any.js') return { runnable: true, reason: null };
  if (/\bdocument\b|\bwindow\b/.test(source)) return { runnable: false, reason: 'requires document/window navigation' };
  return { runnable: false, reason: `unsupported WPT file type ${type}` };
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!await exists(join(root, 'resources/testharness.js').toString())) {
    throw new Error('Missing third_party/wpt/resources/testharness.js. Run: git submodule update --init third_party/wpt');
  }

  const entries: WptManifestEntry[] = [];
  for (const category of WPT_CATEGORIES) {
    const categoryRoot = join(root, category.path).toString();
    if (!await exists(categoryRoot)) continue;
    for await (const file of fs.glob('**/*.{js,html}', { cwd: categoryRoot, onlyFiles: true })) {
      const absolutePath = file.path.toString();
      const relPath = relative(root, absolutePath).toString();
      const type = classify(relPath);
      const source = await fs.readFile(absolutePath);
      const meta = discoverMeta(source);
      let runnableSource = source;
      const missingScripts: string[] = [];
      for (const script of meta.scripts) {
        const scriptPath = resolveMetaScriptPath(absolutePath, script);
        if (await exists(scriptPath)) runnableSource += '\n' + await fs.readFile(scriptPath);
        else missingScripts.push(script);
      }
      const status = runnableStatus(relPath, type, runnableSource, missingScripts, meta.globals);
      entries.push({
        path: relPath,
        category: category.path,
        globals: category.globals,
        type,
        variants: meta.variants.length === 0 ? [''] : meta.variants,
        scripts: meta.scripts,
        runnable: status.runnable,
        reason: status.reason,
        subtests: status.runnable ? discoverSubtests(source) : [],
      });
    }
  }

  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest: WptManifest = {
    generatedFrom: 'third_party/wpt',
    categories: WPT_CATEGORIES.map((category) => category.path),
    entries,
  };
  await fs.writeFile(outPath, [
    "import type { WptManifest } from './manifest.mts';",
    '',
    'export const WPT_MANIFEST: WptManifest = ' + JSON.stringify(manifest, null, 2) + ';',
    '',
  ].join('\n'));
  console.log(`wrote ${outPath} with ${entries.length} WPT entries`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  exit(1);
});
