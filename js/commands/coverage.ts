/**
 * fino:commands/coverage — inspect and gate native V8 coverage artifacts.
 *
 * The command reads the versioned JSON artifact produced by
 * `fino test --coverage`. Its subcommands deliberately answer one question at
 * a time—aggregate summary, per-file totals, uncovered source lines,
 * functions, branches, or Realm participation—using stable labeled text that
 * is concise enough for both people and language models. `check` turns the
 * same data into a non-zero gating result, while `export lcov` provides the
 * conventional interchange format without discarding Realm data from the
 * canonical JSON file.
 *
 * `--input` defaults to `coverage/coverage.json` on the command and every
 * subcommand. Put it after a subcommand when selecting one, for example
 * `fino coverage lines src/config.ts --input artifacts/unit.json`.
 *
 * Coverage ranges originate in the Chrome DevTools Protocol and are remapped
 * according to [ECMA-426](https://tc39.es/ecma426/) before this command reads
 * them. This module does not reinterpret generated offsets or source maps.
 *
 * ```ts no_run
 * import coverage from 'fino:commands/coverage';
 *
 * console.log(await coverage.parse(['files', '--input', 'coverage/coverage.json']));
 * ```
 */
import { DiskFileSystem } from 'fino:file';
import { dirname } from 'fino:file/path';
import { Task, type TaskCliOption } from '../task.ts';

interface Metric {
  covered: number;
  total: number;
  percent: number;
}
interface Totals {
  lines: Metric;
  functions: Metric;
  branches: Metric;
}
interface SourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}
interface CoverageLine {
  line: number;
  hits: number;
  coveredIn: string[];
}
interface CoverageFunction {
  id: string;
  name: string;
  range: SourceRange;
  hits: number;
  coveredIn: string[];
}
interface CoverageBranch {
  id: string;
  range: SourceRange;
  hits: number;
  coveredIn: string[];
}
interface CoverageFile {
  path: string;
  sourceHash: string;
  realmIds: string[];
  totals: Totals;
  lines: CoverageLine[];
  functions: CoverageFunction[];
  branches: CoverageBranch[];
}
interface CoverageRealm {
  id: string;
  parentId: string | null;
  kind: string;
  entry: string | null;
  status: string;
  totals: Totals;
}
interface CoverageArtifact {
  schemaVersion: number;
  tool: { name: string; version: string };
  run: { root: string; id: string; complete: boolean };
  totals: Totals;
  realms: CoverageRealm[];
  files: CoverageFile[];
  warnings: string[];
}

const DEFAULT_INPUT = 'coverage/coverage.json';
const inputOption: TaskCliOption = {
  flags: '--input',
  type: 'string',
  default: DEFAULT_INPUT,
  description: `Coverage JSON artifact (default: ${DEFAULT_INPUT})`,
};

function inputPath(input: { input?: unknown }): string {
  return typeof input.input === 'string' ? input.input : DEFAULT_INPUT;
}

async function readArtifact(path: string): Promise<CoverageArtifact> {
  const bytes = await new DiskFileSystem().readFile(path);
  let artifact: CoverageArtifact;
  try {
    artifact = JSON.parse(new TextDecoder().decode(bytes)) as CoverageArtifact;
  } catch (error) {
    throw new Error(`Unable to parse coverage artifact ${path}: ${String(error)}`);
  }
  if (artifact.schemaVersion !== 1) {
    throw new Error(
      `Unsupported coverage schema ${String(artifact.schemaVersion)} in ${path} (expected 1)`,
    );
  }
  if (!artifact.totals || !Array.isArray(artifact.files) || !Array.isArray(artifact.realms)) {
    throw new Error(`Invalid coverage artifact ${path}`);
  }
  return artifact;
}

function metric(name: string, value: Metric): string {
  return `${name} ${value.covered}/${value.total} ${value.percent.toFixed(2)}%`;
}

function summaryText(artifact: CoverageArtifact): string {
  const incomplete = artifact.realms.filter((realm) => realm.status !== 'complete').length;
  const lines = [
    `coverage ${artifact.run.complete ? 'complete' : 'incomplete'}`,
    metric('lines', artifact.totals.lines),
    metric('functions', artifact.totals.functions),
    metric('branches', artifact.totals.branches),
    `files ${artifact.files.length}`,
    `realms ${artifact.realms.length - incomplete} complete, ${incomplete} incomplete`,
  ];
  for (const warning of artifact.warnings) lines.push(`warning ${warning}`);
  return lines.join('\n');
}

function compactRanges(values: number[]): string {
  if (values.length === 0) return 'none';
  const ranges: string[] = [];
  let start = values[0]!;
  let end = start;
  for (const value of values.slice(1)) {
    if (value === end + 1) {
      end = value;
      continue;
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    start = value;
    end = value;
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges.join(',');
}

function rangeText(range: SourceRange): string {
  return `${range.startLine}:${range.startColumn}-${range.endLine}:${range.endColumn}`;
}

function findFile(artifact: CoverageArtifact, requested: string): CoverageFile {
  const exact = artifact.files.find((file) => file.path === requested);
  if (exact) return exact;
  const suffix = artifact.files.filter(
    (file) => file.path.endsWith(`/${requested}`) || file.path === requested,
  );
  if (suffix.length === 1) return suffix[0]!;
  if (suffix.length > 1) {
    throw new Error(
      `Coverage file ${requested} is ambiguous: ${suffix.map((f) => f.path).join(', ')}`,
    );
  }
  throw new Error(`Coverage file ${requested} was not found`);
}

function selectFiles(artifact: CoverageArtifact, requested: unknown): CoverageFile[] {
  return typeof requested === 'string' ? [findFile(artifact, requested)] : artifact.files;
}

const summary = new Task({
  name: 'summary',
  description: 'Show aggregate coverage totals and Realm completeness',
  outputMode: 'text',
  cli: { options: [inputOption] },
  run: async (input: { input?: unknown }) => summaryText(await readArtifact(inputPath(input))),
});

const files = new Task({
  name: 'files',
  description: 'List deterministic per-file coverage totals',
  outputMode: 'text',
  cli: { options: [inputOption] },
  run: async (input: { input?: unknown }) => {
    const artifact = await readArtifact(inputPath(input));
    if (artifact.files.length === 0) return 'files none';
    return artifact.files
      .map(
        (file) =>
          `file ${file.path} | ${metric('lines', file.totals.lines)} | ${metric('functions', file.totals.functions)} | ${metric('branches', file.totals.branches)}`,
      )
      .join('\n');
  },
});

const lines = new Task({
  name: 'lines',
  description: 'Show covered and uncovered source lines for one file',
  outputMode: 'text',
  cli: {
    options: [inputOption],
    positionals: [{ name: 'file', type: 'string', required: true }],
  },
  run: async (input: { input?: unknown; file?: unknown }) => {
    const artifact = await readArtifact(inputPath(input));
    const file = findFile(artifact, String(input.file));
    const uncovered = file.lines.filter((line) => line.hits === 0).map((line) => line.line);
    const result = [
      `file ${file.path}`,
      metric('lines', file.totals.lines),
      `uncovered-lines ${compactRanges(uncovered)}`,
    ];
    if (uncovered.length > 0) {
      try {
        const bytes = await new DiskFileSystem().readFile(`${artifact.run.root}/${file.path}`);
        const source = new TextDecoder().decode(bytes).split(/\r?\n/);
        for (const line of uncovered) result.push(`source ${line} | ${source[line - 1] ?? ''}`);
      } catch (error) {
        result.push(`warning unable to read source: ${String(error)}`);
      }
    }
    result.push(`covered-in ${file.realmIds.length === 0 ? 'none' : file.realmIds.join(',')}`);
    return result.join('\n');
  },
});

const functions = new Task({
  name: 'functions',
  description: 'List function coverage, optionally for one file',
  outputMode: 'text',
  cli: {
    options: [inputOption],
    positionals: [{ name: 'file', type: 'string' }],
  },
  run: async (input: { input?: unknown; file?: unknown }) => {
    const artifact = await readArtifact(inputPath(input));
    const result: string[] = [];
    for (const file of selectFiles(artifact, input.file)) {
      for (const fn of file.functions) {
        result.push(
          `function ${file.path} ${fn.name} ${rangeText(fn.range)} ${fn.hits > 0 ? 'covered' : 'uncovered'} hits=${fn.hits} realms=${fn.coveredIn.join(',') || 'none'}`,
        );
      }
    }
    return result.join('\n') || 'functions none';
  },
});

const branches = new Task({
  name: 'branches',
  description: 'List V8 block-derived branch coverage, optionally for one file',
  outputMode: 'text',
  cli: {
    options: [inputOption],
    positionals: [{ name: 'file', type: 'string' }],
  },
  run: async (input: { input?: unknown; file?: unknown }) => {
    const artifact = await readArtifact(inputPath(input));
    const result: string[] = [];
    for (const file of selectFiles(artifact, input.file)) {
      for (const branch of file.branches) {
        result.push(
          `branch ${file.path} ${rangeText(branch.range)} ${branch.hits > 0 ? 'covered' : 'uncovered'} hits=${branch.hits} realms=${branch.coveredIn.join(',') || 'none'}`,
        );
      }
    }
    return result.join('\n') || 'branches none';
  },
});

const realms = new Task({
  name: 'realms',
  description: 'List Realm identities, relationships, status, and totals',
  outputMode: 'text',
  cli: { options: [inputOption] },
  run: async (input: { input?: unknown }) => {
    const artifact = await readArtifact(inputPath(input));
    return (
      artifact.realms
        .map(
          (realm) =>
            `realm ${realm.id} kind=${realm.kind} parent=${realm.parentId ?? 'none'} status=${realm.status} entry=${realm.entry ?? 'none'} ${metric('lines', realm.totals.lines)}`,
        )
        .join('\n') || 'realms none'
    );
  },
});

const realm = new Task({
  name: 'realm',
  description: 'Show coverage contributed by one Realm',
  outputMode: 'text',
  cli: {
    options: [inputOption],
    positionals: [{ name: 'id', type: 'string', required: true }],
  },
  run: async (input: { input?: unknown; id?: unknown }) => {
    const artifact = await readArtifact(inputPath(input));
    const id = String(input.id);
    const selected = artifact.realms.find((realm) => realm.id === id);
    if (!selected) throw new Error(`Coverage Realm ${id} was not found`);
    const result = [
      `realm ${selected.id}`,
      `kind ${selected.kind}`,
      `parent ${selected.parentId ?? 'none'}`,
      `status ${selected.status}`,
      `entry ${selected.entry ?? 'none'}`,
      metric('lines', selected.totals.lines),
      metric('functions', selected.totals.functions),
      metric('branches', selected.totals.branches),
    ];
    for (const file of artifact.files.filter((file) => file.realmIds.includes(id))) {
      const covered = file.lines.filter((line) => line.coveredIn.includes(id)).length;
      result.push(`file ${file.path} lines=${covered}/${file.lines.length}`);
    }
    return result.join('\n');
  },
});

function threshold(input: unknown, fallback: number): number {
  return typeof input === 'number' ? input : fallback;
}
function checkMetric(
  failures: string[],
  scope: string,
  name: keyof Totals,
  value: Metric,
  minimum: number,
) {
  if (value.percent < minimum) {
    failures.push(
      `${scope} ${name} ${value.percent.toFixed(2)}% is below ${minimum.toFixed(2)}% (${value.covered}/${value.total})`,
    );
  }
}
const check = new Task({
  name: 'check',
  description: 'Fail when aggregate or per-file coverage is below a threshold',
  outputMode: 'text',
  cli: {
    options: [
      inputOption,
      { flags: '--lines', type: 'number', default: 0, description: 'Minimum line percentage' },
      {
        flags: '--functions',
        type: 'number',
        default: 0,
        description: 'Minimum function percentage',
      },
      {
        flags: '--branches',
        type: 'number',
        default: 0,
        description: 'Minimum branch percentage',
      },
      {
        flags: '--per-file',
        type: 'boolean',
        description: 'Apply the thresholds independently to every file',
      },
    ],
  },
  run: async (input: {
    input?: unknown;
    lines?: unknown;
    functions?: unknown;
    branches?: unknown;
    'per-file'?: unknown;
  }) => {
    const artifact = await readArtifact(inputPath(input));
    const minimums = {
      lines: threshold(input.lines, 0),
      functions: threshold(input.functions, 0),
      branches: threshold(input.branches, 0),
    };
    for (const [name, value] of Object.entries(minimums)) {
      if (value < 0 || value > 100) throw new Error(`${name} threshold must be between 0 and 100`);
    }
    const failures: string[] = [];
    for (const name of ['lines', 'functions', 'branches'] as const) {
      checkMetric(failures, 'total', name, artifact.totals[name], minimums[name]);
    }
    if (input['per-file'] === true) {
      for (const file of artifact.files) {
        for (const name of ['lines', 'functions', 'branches'] as const) {
          checkMetric(failures, `file ${file.path}`, name, file.totals[name], minimums[name]);
        }
      }
    }
    if (!artifact.run.complete) failures.push('coverage run is incomplete');
    if (failures.length > 0) throw new Error(`Coverage check failed:\n${failures.join('\n')}`);
    return [
      'coverage check passed',
      metric('lines', artifact.totals.lines),
      metric('functions', artifact.totals.functions),
      metric('branches', artifact.totals.branches),
    ].join('\n');
  },
});

function lcov(artifact: CoverageArtifact): string {
  const output: string[] = [];
  for (const file of artifact.files) {
    output.push(`SF:${artifact.run.root}/${file.path}`);
    for (const fn of file.functions) output.push(`FN:${fn.range.startLine},${fn.name}`);
    for (const fn of file.functions) output.push(`FNDA:${fn.hits},${fn.name}`);
    output.push(`FNF:${file.functions.length}`);
    output.push(`FNH:${file.functions.filter((fn) => fn.hits > 0).length}`);
    for (const line of file.lines) output.push(`DA:${line.line},${line.hits}`);
    output.push(`LF:${file.lines.length}`);
    output.push(`LH:${file.lines.filter((line) => line.hits > 0).length}`);
    file.branches.forEach((branch, index) => {
      output.push(
        `BRDA:${branch.range.startLine},0,${index},${branch.hits > 0 ? branch.hits : '-'}`,
      );
    });
    output.push(`BRF:${file.branches.length}`);
    output.push(`BRH:${file.branches.filter((branch) => branch.hits > 0).length}`);
    output.push('end_of_record');
  }
  return output.join('\n') + (output.length > 0 ? '\n' : '');
}

const exportLcov = new Task({
  name: 'lcov',
  description: 'Export aggregate original-source coverage as LCOV',
  outputMode: 'text',
  cli: {
    options: [
      inputOption,
      {
        flags: '--output',
        type: 'string',
        default: 'coverage/lcov.info',
        description: 'LCOV output path',
      },
    ],
  },
  run: async (input: { input?: unknown; output?: unknown }) => {
    const artifact = await readArtifact(inputPath(input));
    const output = typeof input.output === 'string' ? input.output : 'coverage/lcov.info';
    const fs = new DiskFileSystem();
    try {
      await fs.mkdir(dirname(output));
    } catch {}
    await fs.writeFile(output, new TextEncoder().encode(lcov(artifact)));
    return `lcov ${output}`;
  },
});

const exportCommand = new Task({
  name: 'export',
  description: 'Export coverage to an interoperable derived format',
  outputMode: 'text',
  children: [exportLcov],
  run: () => 'Use `fino coverage export lcov` to export an LCOV trace file.',
});

/**
 * The `coverage` command mounted by the root Fino CLI.
 *
 * With no subcommand it prints the same aggregate view as `summary`. The
 * default artifact is `coverage/coverage.json`; each subcommand also accepts
 * `--input <path>` after its name.
 */
const command = new Task({
  name: 'coverage',
  description: 'Inspect, gate, and export native test coverage',
  outputMode: 'text',
  cli: { options: [inputOption] },
  children: [summary, files, lines, functions, branches, realms, realm, check, exportCommand],
  run: async (input: { input?: unknown }) => summaryText(await readArtifact(inputPath(input))),
});

export { command as default };
