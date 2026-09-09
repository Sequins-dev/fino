/** Index replacement commits as one unit, regardless of symbol count. */
import { describe, it } from 'fino:test/test';
import { Database } from 'fino:database/sqlite';
import { File } from 'internal:file/handle';
import { createDocTestFixture, removeDocTestFixture, runCli } from './doc-test-helpers.ts';

describe('fino doc: index transactions', () => {
  it('keeps durable syncs bounded as the symbol count grows', async (t) => {
    const fixture = await createDocTestFixture();
    const original = File.prototype.syncSync;
    let syncs = 0;
    File.prototype.syncSync = function () {
      syncs++;
      return original.call(this);
    };
    try {
      const source = fixture.appDir + '/atomic.ts';
      await fixture.fs.writeFile(source, '/** Small index. */\nexport const value0 = 0;\n');
      const small = await runCli(
        ['doc', 'build', 'atomic.ts', '--format', 'markdown'],
        fixture.appDir,
      );
      t.equal(small.result.code, 0, small.stderr);
      const smallSyncs = syncs;
      syncs = 0;
      await fixture.fs.writeFile(
        source,
        '/** Large index. */\n' +
          Array.from(
            { length: 60 },
            (_, i) => `/** Value ${i}. */\nexport const value${i} = ${i};`,
          ).join('\n'),
      );
      const large = await runCli(
        ['doc', 'build', 'atomic.ts', '--format', 'markdown'],
        fixture.appDir,
      );
      t.equal(large.result.code, 0, large.stderr);
      t.ok(
        syncs <= smallSyncs + 12,
        `syncs must not scale per symbol: small=${smallSyncs}, large=${syncs}`,
      );
      const found = await runCli(['doc', 'search', 'value59'], fixture.appDir);
      t.ok(found.stdout.includes('atomic.value59'));
    } finally {
      File.prototype.syncSync = original;
      await removeDocTestFixture(fixture);
    }
  });

  it('preserves the previous index when replacement fails midway', async (t) => {
    const fixture = await createDocTestFixture();
    const prepare = Database.prototype.prepare;
    try {
      const source = fixture.appDir + '/atomic.ts';
      await fixture.fs.writeFile(source, '/** Original index. */\nexport const oldValue = 1;\n');
      const first = await runCli(
        ['doc', 'build', 'atomic.ts', '--format', 'markdown'],
        fixture.appDir,
      );
      t.equal(first.result.code, 0, first.stderr);
      await fixture.fs.writeFile(source, '/** Replacement index. */\nexport const newValue = 2;\n');
      Database.prototype.prepare = function (sql) {
        const statement = prepare.call(this, sql);
        if (sql.startsWith('INSERT INTO symbols')) {
          statement.run = async () => {
            throw new Error('injected index write failure');
          };
        }
        return statement;
      };
      const failed = await runCli(
        ['doc', 'build', 'atomic.ts', '--format', 'markdown'],
        fixture.appDir,
      );
      t.notEqual(failed.result.code, 0);
      t.ok(failed.stderr.includes('injected index write failure'));
      Database.prototype.prepare = prepare;
      const db = await Database.open(fixture.appDir + '/docs/docs.db');
      try {
        const statement = db.prepare('SELECT id FROM symbols ORDER BY id');
        try {
          const ids = (await statement.all()).map((row) => row.id);
          t.ok(ids.includes('atomic.oldValue'), 'previous index remains queryable');
          t.equal(ids.includes('atomic.newValue'), false, 'partial replacement is rolled back');
        } finally {
          statement.finalize();
        }
      } finally {
        await db.close();
      }
    } finally {
      Database.prototype.prepare = prepare;
      await removeDocTestFixture(fixture);
    }
  });
});
