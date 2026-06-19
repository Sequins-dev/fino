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
    try { await fs.unlink(TEST_DIR + '/bad.json'); } catch {}
    try { await fs.unlink(TEST_DIR + '/bad.toml'); } catch {}
    try { await fs.unlink(TEST_DIR + '/quoted.env'); } catch {}
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

  it('maps quoted dotenv and prefixed env values with schema coercion', async (t) => {
    await fs.writeFile(TEST_DIR + '/quoted.env', [
      'APP_SERVER_PORT="8080"',
      "APP_SERVER_HOST='localhost'",
      'IGNORED_VALUE=true',
      '# comment',
      '',
    ].join('\n'));

    const schema = v.object({
      server: v.object({
        port: v.integer(),
        host: v.string(),
        secure: v.boolean(),
      }),
    });

    const loaded = await loadConfig({
      schema,
      sources: [
        { type: 'dotenv', path: TEST_DIR + '/quoted.env', prefix: 'APP_' },
        { type: 'env', values: { APP_SERVER_SECURE: 'yes', OTHER_SERVER_PORT: '9999' }, prefix: 'APP_' },
      ],
    });

    t.deepEqual(loaded.value, {
      server: { port: 8080, host: 'localhost', secure: true },
    }, 'dotenv and env prefix mapping populate and coerce nested values');
    t.deepEqual(loaded.sources[0].keys.sort(), ['server.host', 'server.port'], 'dotenv report includes mapped keys');
    t.deepEqual(loaded.sources[1].keys, ['server.secure'], 'env report excludes non-prefix keys');
  });

  it('parses argv boolean and value forms with mapping', async (t) => {
    const schema = v.object({
      server: v.object({
        port: v.integer(),
      }),
      debug: v.boolean(),
      mode: v.string(),
    });

    const loaded = await loadConfig({
      schema,
      sources: [{
        type: 'argv',
        args: ['--port=9000', '--debug', '--mode', 'test'],
        map: { '--port': 'server.port' },
      }],
    });

    t.deepEqual(loaded.value, {
      server: { port: 9000 },
      debug: true,
      mode: 'test',
    }, 'argv values are parsed, mapped, and coerced');
  });

  it('coerces scalar values inside arrays and tuples and returns undefined for missing get paths', async (t) => {
    const schema = v.object({
      ports: v.array(v.integer()),
      tuple: v.tuple([v.boolean(), v.integer()]),
    });

    const loaded = await loadConfig({
      schema,
      sources: [{ type: 'override', value: { ports: ['3000', '3001'], tuple: ['on', '42'] } }],
    });

    t.deepEqual(loaded.value, {
      ports: [3000, 3001],
      tuple: [true, 42],
    }, 'array and tuple scalar values are coerced from strings');
    t.equal(loaded.get('missing.path'), undefined, 'missing get path returns undefined');
  });

  it('rejects malformed files and unknown source types', async (t) => {
    await fs.writeFile(TEST_DIR + '/bad.json', '{ not json');
    await fs.writeFile(TEST_DIR + '/bad.toml', 'x =');

    await t.rejects(
      () => loadConfig({ schema: v.object({}), sources: [{ type: 'file', path: TEST_DIR + '/bad.json' }] }),
      (err) => err instanceof SyntaxError,
      'malformed JSON rejects',
    );

    await t.rejects(
      () => loadConfig({ schema: v.object({}), sources: [{ type: 'file', path: TEST_DIR + '/bad.toml' }] }),
      /toml/i,
      'malformed TOML rejects',
    );

    await t.rejects(
      () => loadConfig({
        schema: v.object({}),
        sources: [{ type: 'mystery' } as never],
      }),
      (err) => err instanceof ConfigError && err.message.includes("Unknown config source type 'mystery'"),
      'unknown source type rejects with ConfigError',
    );
  });
});
