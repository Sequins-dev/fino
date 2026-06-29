import { WPT_CATEGORIES } from './categories.ts';
import { WPT_MANIFEST } from './manifest.generated.ts';

type SkipBucket =
  | 'server-runtime not applicable'
  | 'harness infrastructure gap'
  | 'missing runtime global'
  | 'known conformance debt'
  | 'not a test';

interface CategorySummary {
  category: string;
  globals: string[];
  runnable: number;
  total: number;
  skipped: Record<SkipBucket, number>;
}

const skipBuckets: SkipBucket[] = [
  'server-runtime not applicable',
  'harness infrastructure gap',
  'missing runtime global',
  'known conformance debt',
  'not a test',
];

function emptySkipped(): Record<SkipBucket, number> {
  return {
    'server-runtime not applicable': 0,
    'harness infrastructure gap': 0,
    'missing runtime global': 0,
    'known conformance debt': 0,
    'not a test': 0,
  };
}

function skipBucket(reason: string): SkipBucket {
  if (reason === 'standalone helper script, not a WPT test entry') {
    return 'not a test';
  }
  if (reason.includes('document/window')) {
    return 'server-runtime not applicable';
  }
  if (
    reason.includes('WPT server') ||
    reason.includes('.sub') ||
    reason.includes('missing WPT META script')
  ) {
    return 'harness infrastructure gap';
  }
  if (
    reason.includes('Worker') ||
    reason.includes('Cache API') ||
    reason.includes('ServiceWorker') ||
    reason.includes('DedicatedWorker') ||
    reason.includes('FileReader in document or worker') ||
    reason.includes('importScripts')
  ) {
    return 'missing runtime global';
  }
  return 'known conformance debt';
}

function summarize(): CategorySummary[] {
  return WPT_CATEGORIES.map((category) => {
    const entries = WPT_MANIFEST.entries.filter((entry) => entry.category === category.path);
    const skipped = emptySkipped();
    let runnable = 0;
    for (const entry of entries) {
      if (entry.runnable) {
        runnable++;
      } else {
        skipped[skipBucket(entry.reason ?? 'not runnable in Fino')]++;
      }
    }
    return {
      category: category.path,
      globals: category.globals,
      runnable,
      total: entries.length,
      skipped,
    };
  });
}

console.log([
  '| Category | Globals | Runnable / total | Server-runtime not applicable | Harness infrastructure gap | Missing runtime global | Known conformance debt | Not a test |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...summarize().map((summary) => [
    `\`${summary.category}\``,
    summary.globals.map((global) => `\`${global}\``).join(', '),
    `${summary.runnable} / ${summary.total}`,
    ...skipBuckets.map((bucket) => String(summary.skipped[bucket])),
  ].join(' | ')).map((row) => `| ${row} |`),
].join('\n'));
