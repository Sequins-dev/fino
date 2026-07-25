import { after, before, describe, it } from 'fino:test/test';
import { ConfigError, ConfigSecretProvider, loadConfig, SecretGrant, SecretValue } from 'fino:config';
import { DiskFileSystem } from 'fino:file';
import { ImportMap, Realm } from 'fino:realm';
import { sealCookie } from 'fino:security/cookie';
import { v } from 'fino:validate';
const TEST_DIR = '/tmp/fino-config-test-' + Math.floor(Math.random() * 1e6);
const writeText = (fs: DiskFileSystem, path: string, text: string): Promise<void> => fs.writeFile(path, new TextEncoder().encode(text));
describe('fino:config', () => {
  let fs: DiskFileSystem;
  before(async () => {
    fs = new DiskFileSystem();
    await fs.mkdir(TEST_DIR);
  });
  after(async () => {
    try {
      await fs.unlink(TEST_DIR + '/app.json');
    } catch {}
    try {
      await fs.unlink(TEST_DIR + '/app.toml');
    } catch {}
    try {
      await fs.unlink(TEST_DIR + '/bad.json');
    } catch {}
    try {
      await fs.unlink(TEST_DIR + '/bad.toml');
    } catch {}
    try {
      await fs.unlink(TEST_DIR + '/quoted.env');
    } catch {}
    try {
      await fs.unlink(TEST_DIR + '/.env');
    } catch {}
    try {
      await fs.unlink(TEST_DIR + '/secrets.sealed');
    } catch {}
    await fs.rmdir(TEST_DIR);
  });
  it('loads explicit sources in list order with later sources taking precedence', async (t) => {
    await writeText(fs, TEST_DIR + '/app.json', JSON.stringify({
      server: {
        host: 'json-host',
        port: 4e3
      },
      feature: true
    }));
    await writeText(fs, TEST_DIR + '/app.toml', [
      'mode = "toml"',
      '[server]',
      'host = "toml-host"',
      'port = 5000',
      ''
    ].join('\n'));
    await writeText(fs, TEST_DIR + '/.env', [
      'APP_PORT=6000',
      'APP_SECRET=from-dotenv',
      ''
    ].join('\n'));
    const schema = v.object({
      server: v.object({
        host: v.string(),
        port: v.integer().min(1)
      }),
      mode: v.string().default('dev'),
      feature: v.boolean().default(false),
      secret: v.string().optional()
    });
    const loaded = await loadConfig({
      schema,
      sources: [
        {
          type: 'defaults',
          value: {
            server: {
              host: 'default-host',
              port: 3e3
            },
            mode: 'default'
          }
        },
        {
          type: 'file',
          path: TEST_DIR + '/app.json'
        },
        {
          type: 'file',
          path: TEST_DIR + '/app.toml'
        },
        {
          type: 'dotenv',
          path: TEST_DIR + '/.env',
          map: {
            APP_PORT: 'server.port',
            APP_SECRET: 'secret'
          }
        },
        {
          type: 'env',
          values: { APP_HOST: 'env-host' },
          map: { APP_HOST: 'server.host' }
        },
        {
          type: 'argv',
          args: [
            '--server.port',
            '7000',
            '--mode',
            'prod'
          ],
          map: {
            '--server.port': 'server.port',
            '--mode': 'mode'
          }
        },
        {
          type: 'override',
          value: { feature: false }
        }
      ]
    });
    t.deepEqual(loaded.value, {
      server: {
        host: 'env-host',
        port: 7e3
      },
      mode: 'prod',
      feature: false,
      secret: 'from-dotenv'
    }, 'sources merge in caller-provided precedence order');
    t.equal(loaded.get('server.port'), 7e3, 'get reads nested validated values');
    t.equal(loaded.sources.length, 7, 'source reports are returned');
  });
  it('wraps validation failures in ConfigError with redacted secret values', async (t) => {
    const schema = v.object({ secret: v.string().min(12) });
    await t.rejects(async () => loadConfig({
      schema,
      secrets: ['secret'],
      sources: [{
        type: 'override',
        value: { secret: 'short' }
      }]
    }), (err) => err instanceof ConfigError
      && err.message.includes('[redacted]')
      && !err.message.includes('short')
      && JSON.stringify(err.issues).includes('[redacted]')
      && !JSON.stringify(err.issues).includes('short'), 'config errors redact configured secret paths in messages and structured issues');
  });
  it('tags secret env values and redacts accidental rendering', async (t) => {
    const loaded = await loadConfig({
      schema: v.object({
        database: v.object({ password: v.string() })
      }),
      sources: [{
        type: 'secret-env',
        values: { APP_DATABASE_PASSWORD: 'correct horse battery staple' },
        prefix: 'APP_'
      }]
    });
    const secret = loaded.get('database.password');
    t.ok(secret instanceof SecretValue, 'secret source values carry a secret type');
    t.equal(secret.reveal(), 'correct horse battery staple', 'secret access requires an explicit reveal');
    t.equal(String(secret), '[redacted]', 'string coercion redacts');
    t.equal(JSON.stringify({ secret }), '{"secret":"[redacted]"}', 'JSON rendering redacts');
    t.deepEqual(loaded.sources[0].keys, ['database.password'], 'source reports contain paths, not secret values');
    t.equal(JSON.stringify(loaded.sources).includes('correct horse'), false, 'source reports do not disclose secret values');
  });
  it('loads authenticated sealed secret files and rejects the wrong key', async (t) => {
    const key = 'test-only-sealed-config-key';
    const plaintext = JSON.stringify({
      api: { token: 'sealed-token' }
    });
    await writeText(fs, TEST_DIR + '/secrets.sealed', sealCookie(plaintext, key));
    const loaded = await loadConfig({
      schema: v.object({
        api: v.object({ token: v.string() })
      }),
      sources: [{
        type: 'secret-file',
        path: TEST_DIR + '/secrets.sealed',
        key
      }]
    });
    const secret = loaded.get('api.token');
    t.ok(secret instanceof SecretValue, 'sealed file leaves are tagged as secrets');
    t.equal(secret.reveal(), 'sealed-token', 'authenticated plaintext is available explicitly');
    await t.rejects(() => loadConfig({
      schema: v.object({
        api: v.object({ token: v.string() })
      }),
      sources: [{
        type: 'secret-file',
        path: TEST_DIR + '/secrets.sealed',
        key: 'wrong-key'
      }]
    }), (err) => err instanceof ConfigError
      && !err.message.includes('sealed-token'), 'authentication failures do not expose plaintext');
    await writeText(
      fs,
      TEST_DIR + '/secrets.sealed',
      sealCookie('{"api":{"token":"must-not-appear"}, trailing}', key)
    );
    await t.rejects(() => loadConfig({
      schema: v.object({
        api: v.object({ token: v.string() })
      }),
      sources: [{
        type: 'secret-file',
        path: TEST_DIR + '/secrets.sealed',
        key
      }]
    }), (err) => err instanceof ConfigError
      && err.message.includes('Unable to parse sealed secret file')
      && !err.message.includes('must-not-appear'), 'sealed plaintext is omitted from parse errors');
  });
  it('grants named secrets to realms through a provider-backed facade', async (t) => {
    const loaded = await loadConfig({
      schema: v.object({
        api: v.object({
          token: v.string(),
          internal: v.string()
        })
      }),
      sources: [{
        type: 'secret-env',
        values: {
          API_TOKEN: 'realm-token',
          API_INTERNAL: 'must-not-cross'
        },
        map: {
          API_TOKEN: 'api.token',
          API_INTERNAL: 'api.internal'
        }
      }]
    });
    const grant = new SecretGrant(new ConfigSecretProvider(loaded), ['api.token']);
    await t.rejects(() => grant.get('api.internal'), /not granted/i, 'the parent-side grant rejects ungranted names');
    const facade = grant.facade('app:secrets');
    const realm = Realm.fromSource<() => Promise<{
      token: string;
      denied: string;
      processEnv: string;
    }>>(`
      import { get } from 'app:secrets';
      export default async function () {
        let denied = '';
        try {
          await get('api.internal');
        } catch (error) {
          denied = String(error);
        }
        return {
          token: await get('api.token'),
          denied,
          processEnv: typeof globalThis.process,
        };
      }
    `, {
      overrides: ImportMap.deny([{
        pattern: 'app:secrets',
        directive: facade
      }])
    });
    const result = await realm.call();
    t.equal(result.token, 'realm-token', 'the granted value crosses the explicit facade');
    t.ok(result.denied.includes('not granted'), 'ungranted values remain unavailable in the child');
    t.equal(result.processEnv, 'undefined', 'the child does not receive ambient process-global secrets');
  });
  it('maps quoted dotenv and prefixed env values with schema coercion', async (t) => {
    await writeText(fs, TEST_DIR + '/quoted.env', [
      'APP_SERVER_PORT="8080"',
      'APP_SERVER_HOST=\'localhost\'',
      'IGNORED_VALUE=true',
      '# comment',
      ''
    ].join('\n'));
    const schema = v.object({ server: v.object({
      port: v.integer(),
      host: v.string(),
      secure: v.boolean()
    }) });
    const loaded = await loadConfig({
      schema,
      sources: [{
        type: 'dotenv',
        path: TEST_DIR + '/quoted.env',
        prefix: 'APP_'
      }, {
        type: 'env',
        values: {
          APP_SERVER_SECURE: 'yes',
          OTHER_SERVER_PORT: '9999'
        },
        prefix: 'APP_'
      }]
    });
    t.deepEqual(loaded.value, { server: {
      port: 8080,
      host: 'localhost',
      secure: true
    } }, 'dotenv and env prefix mapping populate and coerce nested values');
    t.deepEqual(loaded.sources[0].keys.sort(), ['server.host', 'server.port'], 'dotenv report includes mapped keys');
    t.deepEqual(loaded.sources[1].keys, ['server.secure'], 'env report excludes non-prefix keys');
  });
  it('parses argv boolean and value forms with mapping', async (t) => {
    const schema = v.object({
      server: v.object({ port: v.integer() }),
      debug: v.boolean(),
      mode: v.string()
    });
    const loaded = await loadConfig({
      schema,
      sources: [{
        type: 'argv',
        args: [
          '--port=9000',
          '--debug',
          '--mode',
          'test'
        ],
        map: { '--port': 'server.port' }
      }]
    });
    t.deepEqual(loaded.value, {
      server: { port: 9e3 },
      debug: true,
      mode: 'test'
    }, 'argv values are parsed, mapped, and coerced');
  });
  it('coerces scalar values inside arrays and tuples and returns undefined for missing get paths', async (t) => {
    const schema = v.object({
      ports: v.array(v.integer()),
      tuple: v.tuple([v.boolean(), v.integer()])
    });
    const loaded = await loadConfig({
      schema,
      sources: [{
        type: 'override',
        value: {
          ports: ['3000', '3001'],
          tuple: ['on', '42']
        }
      }]
    });
    t.deepEqual(loaded.value, {
      ports: [3e3, 3001],
      tuple: [true, 42]
    }, 'array and tuple scalar values are coerced from strings');
    t.equal(loaded.get('missing.path'), undefined, 'missing get path returns undefined');
  });
  it('rejects malformed files and unknown source types', async (t) => {
    await writeText(fs, TEST_DIR + '/bad.json', '{ not json');
    await writeText(fs, TEST_DIR + '/bad.toml', 'x =');
    await t.rejects(() => loadConfig({
      schema: v.object({}),
      sources: [{
        type: 'file',
        path: TEST_DIR + '/bad.json'
      }]
    }), (err) => err instanceof SyntaxError, 'malformed JSON rejects');
    await t.rejects(() => loadConfig({
      schema: v.object({}),
      sources: [{
        type: 'file',
        path: TEST_DIR + '/bad.toml'
      }]
    }), /toml/i, 'malformed TOML rejects');
    await t.rejects(() => loadConfig({
      schema: v.object({}),
      sources: [{ type: 'mystery' } as never]
    }), (err) => err instanceof ConfigError && err.message.includes('Unknown config source type \'mystery\''), 'unknown source type rejects with ConfigError');
  });
});
