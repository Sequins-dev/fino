import { describe, it } from 'fino:test/test';
import {
  aggregateCoverageShards,
  coverageMetric,
  generatedLines,
  offsetToLineColumn,
  sourceHash,
  type CoverageRunConfig,
  type RealmShard,
} from 'internal:coverage/model';

const config: CoverageRunConfig = {
  outputPath: '/project/coverage/coverage.json',
  shardDir: '/project/coverage/.shards',
  root: '/project',
  runId: 'test-run',
  ownerPid: 1,
};

function shard(id: string, hits: number, hash = 'fnv64:one'): RealmShard {
  return {
    realm: {
      id,
      parentId: null,
      kind: 'test',
      entry: null,
      status: 'complete',
      totals: {
        lines: coverageMetric(0, 0),
        functions: coverageMetric(0, 0),
        branches: coverageMetric(0, 0),
      },
    },
    files: [
      {
        path: 'src/value.ts',
        sourceHash: hash,
        lines: [{ line: 1, hits }],
        functions: [
          {
            name: 'value',
            range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 5 },
            hits,
          },
        ],
        branches: [
          {
            range: { startLine: 2, startColumn: 0, endLine: 2, endColumn: 4 },
            hits,
          },
        ],
      },
    ],
    warnings: [],
  };
}

describe('coverage model', () => {
  it('uses V8 UTF-16 offsets and excludes CRLF terminators from lines', (t) => {
    const source = "const fire = '🔥';\r\nreturn fire;\n";
    const lines = generatedLines(source);
    t.deepEqual(
      lines.map((line) => [line.start, line.end, line.text]),
      [
        [0, 18, "const fire = '🔥';"],
        [20, 32, 'return fire;'],
      ],
      'line ranges use UTF-16 code units and omit both CR and LF',
    );
    t.deepEqual(
      offsetToLineColumn(source, 20),
      { line: 1, column: 0 },
      'the line following an astral character and CRLF begins at column zero',
    );
  });

  it('produces stable hashes and two-decimal metrics', (t) => {
    t.equal(sourceHash(new Uint8Array()), 'fnv64:cbf29ce484222325', 'empty FNV-1a is stable');
    t.deepEqual(coverageMetric(2, 3), { covered: 2, total: 3, percent: 66.67 });
    t.deepEqual(coverageMetric(0, 0), { covered: 0, total: 0, percent: 0 });
  });

  it('aggregates Realm hits and preserves Realm attribution', async (t) => {
    const artifact = await aggregateCoverageShards(config, '1.2.3', [
      shard('realm-b', 0),
      shard('realm-a', 2),
    ]);
    t.equal(artifact.run.complete, true);
    t.deepEqual(artifact.files[0]?.realmIds, ['realm-a', 'realm-b']);
    t.deepEqual(artifact.files[0]?.lines[0], {
      line: 1,
      hits: 2,
      coveredIn: ['realm-a'],
    });
    t.deepEqual(artifact.totals.lines, { covered: 1, total: 1, percent: 100 });
    t.deepEqual(
      artifact.realms.map((realm) => [realm.id, realm.totals.lines.covered]),
      [
        ['realm-a', 1],
        ['realm-b', 0],
      ],
    );
  });

  it('marks missing Realms and conflicting source hashes incomplete', async (t) => {
    const missing = shard('realm-b', 0, 'fnv64:two');
    missing.realm.status = 'missing';
    missing.warnings.push('Realm did not submit a final coverage snapshot');
    const artifact = await aggregateCoverageShards(config, '1.2.3', [shard('realm-a', 1), missing]);
    t.equal(artifact.run.complete, false);
    t.ok(
      artifact.warnings.some((warning) => warning.includes('conflicting source hashes')),
      'hash conflicts are explicit',
    );
    t.ok(
      artifact.warnings.some((warning) => warning.startsWith('realm-b:')),
      'Realm warnings retain their origin',
    );
  });
});
