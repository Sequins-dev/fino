/**
 * Real upstream Web Platform Tests integration.
 *
 * The schedule is generated from `third_party/wpt`; test bodies are never
 * copied into this repository. Runnable `.any.js` files execute in isolated
 * Fino child processes after loading upstream `resources/testharness.js`.
 */
import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Process, cwd, env, execPath } from 'fino:process';
import * as loop from 'internal:runtime/loop';
import { WPT_MANIFEST } from './fixtures/wpt/manifest.generated.ts';
import { specSuiteSkipReason, specSuitesEnabled } from './spec-gate.ts';
import type { WptManifestEntry } from './fixtures/wpt/manifest.ts';
const fs = new DiskFileSystem();
const decoder = new TextDecoder();
const setupMessage = [
  'Real WPT checkout is missing or the generated manifest is stale.',
  'Run:',
  '  git submodule update --init third_party/wpt',
  '  ./target/release/fino tests/integration/fixtures/wpt/generate-manifest.ts',
].join('\n');
async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}
async function collect(readable: AsyncIterable<Uint8Array>): Promise<string> {
  let out = '';
  for await (const chunk of readable) out += decoder.decode(chunk);
  return out;
}
function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    loop.timeout(ms).then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]);
}
async function runWpt(
  entry: WptManifestEntry,
  subtest: string | null,
  variant: string,
): Promise<void> {
  const proc = new Process(
    execPath,
    ['tests/integration/fixtures/wpt/runner-child.ts', entry.path, subtest ?? '', variant],
    { cwd: cwd() },
  );
  proc.stdin.close();
  const stdout = collect(proc.stdout);
  const stderr = collect(proc.stderr);
  const status = await timeout(proc.wait(), 1e4, `WPT ${entry.path}`);
  const out = (await stdout).trim();
  const err = await stderr;
  if (status.code !== 0) {
    let message = out;
    try {
      const parsed = JSON.parse(out.split(/\r?\n/).at(-1) ?? '{}');
      message = parsed.message ?? JSON.stringify(parsed.results ?? parsed);
    } catch {
      if (err.trim().length > 0) message = err.trim();
    }
    throw new Error(message);
  }
}
const hasCheckout = await exists(`${cwd()}/third_party/wpt/resources/testharness.js`);
const hasManifest = WPT_MANIFEST.entries.length > 0;
const categoryFilter = env.FINO_WPT_CATEGORY;
const pathFilter = env.FINO_WPT_PATH;
const fileLevel = env.FINO_WPT_FILE_LEVEL === '1';
const deferredCategories = new Map([
  [
    'encoding',
    [
      'deferred: full WHATWG Encoding WPT coverage needs legacy decoder tables',
      'and stateful encoders/decoders before this category can be useful for',
      'category-by-category conformance work',
    ].join(' '),
  ],
]);
function selectedEntries(): WptManifestEntry[] {
  let entries = WPT_MANIFEST.entries;
  if (categoryFilter !== undefined && categoryFilter.length > 0) {
    const selected = new Set(
      categoryFilter
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    );
    entries = entries.filter((entry) => selected.has(entry.category));
  }
  if (pathFilter !== undefined && pathFilter.length > 0) {
    entries = entries.filter((entry) => entry.path.includes(pathFilter));
  }
  return entries;
}
describe('upstream WPT web globals', () => {
  if (!specSuitesEnabled) {
    it('preflight', { skip: specSuiteSkipReason }, () => {});
  } else if (!hasCheckout || !hasManifest) {
    it('preflight', () => {
      throw new Error(setupMessage);
    });
  } else {
    const entries = selectedEntries();
    if (entries.length === 0) {
      it('preflight', () => {
        throw new Error(
          `No WPT entries matched FINO_WPT_CATEGORY=${categoryFilter ?? ''} FINO_WPT_PATH=${pathFilter ?? ''}`,
        );
      });
    }
    for (const entry of entries) {
      const variants = entry.variants.length === 0 ? [''] : entry.variants;
      const variantSuffix = (variant: string) => (variant.length === 0 ? '' : ` ${variant}`);
      const deferredReason = deferredCategories.get(entry.category);
      const skipReason =
        deferredReason ?? (entry.runnable ? false : (entry.reason ?? 'not runnable in Fino'));
      describe(`${entry.category} ${entry.path}`, { skip: skipReason }, () => {
        if (fileLevel || entry.subtests.length === 0) {
          for (const variant of variants) {
            it(`file${variantSuffix(variant)}`, async () => {
              await runWpt(entry, null, variant);
            });
          }
        } else {
          for (const subtest of entry.subtests) {
            for (const variant of variants) {
              it(`${subtest.name}${variantSuffix(variant)}`, async () => {
                await runWpt(entry, subtest.name, variant);
              });
            }
          }
        }
      });
    }
  }
});
