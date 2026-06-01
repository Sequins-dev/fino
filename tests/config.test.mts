import { after, before, describe, it } from 'fino:test/test';
import { ConfigError, loadConfig } from 'fino:config';
import { DiskFileSystem } from 'fino:file';
import { v } from 'fino:validate';

const TEST_DIR = '/tmp/fino-config-test-' + Math.floor(Math.random() * 1_000_000);

describe('fino:config', () => {
  let fs: DiskFileSystem;

  before(async () => {
    fs = new DiskFileSystem();
    await fs.mkdir(TEST_DIR);
  });

  after(async () => {
    try { await fs.unlink(TEST_DIR + '/app.json'); } catch {}
    try { await fs.unlink(TEST_DIR + '/app.toml'); } catch {}
    try { await fs.unlink(TEST_DIR + '/.env'); } catch {}
    await fs.rmdir(TEST_DIR);
  });

  it('loads explicit sources in list order with later sources taking precedence', async (t) => {
    await fs.writeFile(TEST_DIR + '/app.json', JSON.stringify({
      server: { host: 'json-host', port: 4000 },
      feature: true,
    }));
    await fs.writeFile(TEST_DIR + '/app.toml', [
      'mode = "toml"',
      '[server]',
      'host = "toml-host"',
      'port = 5000',
      '',
    ].join('\n'));
    await fs.writeFile(TEST_DIR + '/.env', [
      'APP_PORT=6000',
      'APP_SECRET=from-dotenv',
      '',
    ].join('\n'));

    const schema = v.object({
      server: v.object({
        host: v.string(),
        port: v.integer().min(1),
      }),
      mode: v.string().default('dev'),
      feature: v.boolean().default(false),
      secret: v.string().optional(),
    });

    const loaded = await loadConfig({
      schema,
      sources: [
        { type: 'defaults', value: { server: { host: 'default-host', port: 3000 }, mode: 'default' } },
        { type: 'file', path: TEST_DIR + '/app.json' },
        { type: 'file', path: TEST_DIR + '/app.toml' },
        { type: 'dotenv', path: TEST_DIR + '/.env', map: { APP_PORT: 'server.port', APP_SECRET: 'secret' } },
        { type: 'env', values: { APP_HOST: 'env-host' }, map: { APP_HOST: 'server.host' } },
        { type: 'argv', args: ['--server.port', '7000', '--mode', 'prod'], map: { '--server.port': 'server.port', '--mode': 'mode' } },
        { type: 'override', value: { feature: false } },
      ],
    });

    t.deepEqual(loaded.value, {
      server: { host: 'env-host', port: 7000 },
      mode: 'prod',
      feature: false,
      secret: 'from-dotenv',
    }, 'sources merge in caller-provided precedence order');
    t.equal(loaded.get('server.port'), 7000, 'get reads nested validated values');
    t.equal(loaded.sources.length, 7, 'source reports are returned');
  });

  it('wraps validation failures in ConfigError with redacted secret values', async (t) => {
    const schema = v.object({
      secret: v.string().min(12),
    });

    await t.rejects(
      async () => loadConfig({
        schema,
        secrets: ['secret'],
        sources: [
          { type: 'override', value: { secret: 'short' } },
        ],
      }),
      (err) => err instanceof ConfigError
        && err.message.includes('[redacted]')
        && !err.message.includes('short')
        && err.issues.length === 1,
      'config errors redact configured secret paths',
    );
  });
});
