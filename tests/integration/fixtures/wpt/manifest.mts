export interface WptManifestSubtest {
  name: string;
  kind: 'test' | 'promise_test' | 'async_test';
}

export interface WptManifestEntry {
  path: string;
  category: string;
  globals: string[];
  type: string;
  variants: string[];
  scripts: string[];
  runnable: boolean;
  reason: string | null;
  subtests: WptManifestSubtest[];
}

export interface WptManifest {
  generatedFrom: string;
  categories: string[];
  entries: WptManifestEntry[];
}
