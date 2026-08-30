/** Documentation types integration tests. */
import { after, before, describe, it } from 'fino:test/test';
import {
  createDocTestFixture,
  type DocTestFixture,
  removeDocTestFixture,
  type DocJsonOutput,
  REPO_DIR,
  TEST_DIR,
  ensureDir,
  exists,
  removeTree,
  runCli,
} from './doc-test-helpers.ts';

describe('fino doc: types', () => {
  let fixture!: DocTestFixture;
  let fs!: DocTestFixture['fs'];
  let appDir!: string;

  before(async () => {
    fixture = await createDocTestFixture();
    ({ fs, appDir } = fixture);
  });

  after(async () => {
    await removeDocTestFixture(fixture);
  });
  it('links archive helper types from public signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(appDir + '/archive.ts', await fs.readFile(REPO_DIR + '/js/archive.ts'));
    const run = await runCli(
      ['doc', 'build', './archive.ts', '--format', 'both', '--title', 'Archive API'],
      appDir,
    );
    t.equal(run.result.code, 0, 'archive doc build exits successfully');
    t.equal(run.stderr, '', 'archive doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/archive.html');
    for (const name of [
      'ArchiveFormat',
      'ArchiveKind',
      'ZipCompression',
      'ArchiveEntryHandle',
      'ArchiveInput',
    ]) {
      t.ok(html.includes(`id="archive.${name}"`), `html includes ${name} export`);
      t.ok(
        html.includes(`href="#archive.${name}">${name}</a>`),
        `html links ${name} from signatures`,
      );
    }
  });
  it('links compression option types from public signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(appDir + '/compress.ts', await fs.readFile(REPO_DIR + '/js/compress.ts'));
    await ensureDir(fs, appDir + '/internal/compress');
    await fs.writeFile(
      appDir + '/internal/compress/common.ts',
      await fs.readFile(REPO_DIR + '/js/internal/compress/common.ts'),
    );
    const run = await runCli(
      [
        'doc',
        'build',
        './compress.ts',
        './internal/compress/common.ts',
        '--format',
        'both',
        '--title',
        'Compress API',
      ],
      appDir,
    );
    t.equal(run.result.code, 0, 'compress doc build exits successfully');
    t.equal(run.stderr, '', 'compress doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/compress.html');
    for (const name of [
      'ByteInput',
      'CompressionFormat',
      'CompressOptions',
      'DecompressOptions',
      'CompressionTransform',
    ]) {
      t.ok(html.includes(`id="compress.${name}"`), `html includes ${name} export`);
      t.ok(
        html.includes(`href="#compress.${name}">${name}</a>`),
        `html links ${name} from signatures`,
      );
    }
    t.equal(
      html.includes('InternalCompressOptions'),
      false,
      'html does not expose internal compress option aliases',
    );
  });
  it('links jobs record types from public signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/internal/jobs');
    await fs.writeFile(appDir + '/jobs.ts', await fs.readFile(REPO_DIR + '/js/jobs.ts'));
    await fs.writeFile(
      appDir + '/internal/jobs/store.ts',
      await fs.readFile(REPO_DIR + '/js/internal/jobs/store.ts'),
    );
    const run = await runCli(
      [
        'doc',
        'build',
        './jobs.ts',
        './internal/jobs/store.ts',
        '--format',
        'both',
        '--title',
        'Jobs API',
      ],
      appDir,
    );
    t.equal(run.result.code, 0, 'jobs doc build exits successfully');
    t.equal(run.stderr, '', 'jobs doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/jobs.html');
    for (const name of ['JobRecord', 'ScheduleRecord', 'QueueStats']) {
      t.ok(html.includes(`id="jobs.${name}"`), `html includes ${name} export`);
      t.ok(html.includes(`href="#jobs.${name}">${name}</a>`), `html links ${name} from signatures`);
    }
  });
  it('links DNS server family from public signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/net');
    await fs.writeFile(appDir + '/net/dns.ts', await fs.readFile(REPO_DIR + '/js/net/dns.ts'));
    const run = await runCli(
      ['doc', 'build', './net/dns.ts', '--format', 'both', '--title', 'DNS API'],
      appDir,
    );
    t.equal(run.result.code, 0, 'dns doc build exits successfully');
    t.equal(run.stderr, '', 'dns doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/net/dns.html');
    t.ok(html.includes('id="dns.DnsServerFamily"'), 'html includes DnsServerFamily export');
    t.ok(
      html.includes('href="#dns.DnsServerFamily">DnsServerFamily</a>'),
      'html links DnsServerFamily from DnsServer signature',
    );
    for (const name of [
      '_encodeName',
      '_buildQuery',
      '_decodeName',
      '_parseResponse',
      '_parseResolvConf',
      '_randomQueryId',
      '_reverseIP',
    ]) {
      t.equal(
        html.includes(`id="dns.${name}"`),
        false,
        `html does not include internal ${name} helper`,
      );
    }
    for (const name of [
      'DsRecord',
      'DnskeyRecord',
      'RrsigRecord',
      'NsecRecord',
      'Nsec3Record',
      'Nsec3ParamRecord',
      'DnsEdnsMetadata',
    ]) {
      t.ok(html.includes(`id="dns.${name}"`), `html includes ${name} export`);
    }
    t.ok(
      html.includes('href="#dns.DnsEdnsMetadata">DnsEdnsMetadata</a>'),
      'html links DnsEdnsMetadata from DnsResponse signature',
    );
  });
  it('links HTTP arena from serialize signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(
      appDir + '/http-wire.ts',
      `/**
 * HTTP wire fixture.
 */
export class Arena {
/**
 * Allocate bytes.
 */
alloc(n: number): Uint8Array {
  return new Uint8Array(n);
}
}

/**
 * Serialize a request.
 */
export function serializeRequest(req: Request, arena?: Arena): AsyncIterable<Uint8Array> {
return [] as Uint8Array[];
}

/**
 * Serialize a response.
 */
export function serializeResponse(res: Response, arena?: Arena): AsyncIterable<Uint8Array> {
return [] as Uint8Array[];
}
`,
    );
    const run = await runCli(
      ['doc', 'build', './http-wire.ts', '--format', 'both', '--title', 'HTTP Wire API'],
      appDir,
    );
    t.equal(run.result.code, 0, 'http wire doc build exits successfully');
    t.equal(run.stderr, '', 'http wire doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/http-wire.html');
    t.ok(html.includes('id="http-wire.Arena"'), 'html includes Arena export');
    t.ok(html.includes('id="http-wire.serializeRequest"'), 'html includes serializeRequest export');
    t.ok(
      html.includes('id="http-wire.serializeResponse"'),
      'html includes serializeResponse export',
    );
    t.ok(
      html.includes('href="#http-wire.Arena">Arena</a>'),
      'html links Arena from serialize signatures',
    );
  });
  it('documents HTTP app context and OpenAPI metadata types', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/net/http');
    await fs.writeFile(
      appDir + '/net/http/app.ts',
      await fs.readFile(REPO_DIR + '/js/net/http/app.ts'),
    );
    const run = await runCli(
      ['doc', 'build', './net/http/app.ts', '--format', 'both', '--title', 'HTTP App API'],
      appDir,
    );
    t.equal(run.result.code, 0, 'http app doc build exits successfully');
    t.equal(run.stderr, '', 'http app doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/net/http/app.html');
    for (const name of [
      'SseContext',
      'SseHandler',
      'OpenApiParameter',
      'OpenApiRequestBody',
      'OpenApiResponse',
    ]) {
      t.ok(html.includes(`id="app.${name}"`), `html includes ${name} export`);
    }
    t.ok(
      html.includes('href="#app.SseContext">SseContext</a>'),
      'html links SseContext from SseHandler signature',
    );
    t.ok(
      html.includes('href="#app.OpenApiParameter">OpenApiParameter</a>'),
      'html links OpenApiParameter from OperationMeta',
    );
    t.ok(
      html.includes('href="#app.OpenApiRequestBody">OpenApiRequestBody</a>'),
      'html links OpenApiRequestBody from OperationMeta',
    );
    t.ok(
      html.includes('href="#app.OpenApiResponse">OpenApiResponse</a>'),
      'html links OpenApiResponse from OperationMeta',
    );
  });
  it('documents HTTP server incoming base types', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/net/http');
    await fs.writeFile(
      appDir + '/net/http/server.ts',
      await fs.readFile(REPO_DIR + '/js/net/http/server.ts'),
    );
    const run = await runCli(
      ['doc', 'build', './net/http/server.ts', '--format', 'both', '--title', 'HTTP Server API'],
      appDir,
    );
    t.equal(run.result.code, 0, 'http server doc build exits successfully');
    t.equal(run.stderr, '', 'http server doc build writes no stderr');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const serverModule = json.modules.find((moduleDoc) => moduleDoc.path === 'net/http/server.ts');
    t.ok(serverModule, 'server module is documented');
    t.ok(
      serverModule!.exports.some((item) => item.name === 'IncomingBase'),
      'server module exports IncomingBase',
    );
    const markdown = await fs.readFile(docsDir + '/net/http/server.md');
    t.ok(markdown.includes('## IncomingBase'), 'server markdown includes IncomingBase');
  });
  it('documents CookieJar from the security cookie module', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/security');
    await fs.writeFile(
      appDir + '/security/cookie.ts',
      await fs.readFile(REPO_DIR + '/js/security/cookie.ts'),
    );
    const run = await runCli(
      ['doc', 'build', './security/cookie.ts', '--format', 'both', '--title', 'Cookie API'],
      appDir,
    );
    t.equal(run.result.code, 0, 'security cookie doc build exits successfully');
    t.equal(run.stderr, '', 'security cookie doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/security/cookie.html');
    t.ok(
      html.includes('id="cookie.CookieJar"'),
      'html includes CookieJar export from security cookie module',
    );
    t.ok(
      html.includes('id="cookie.CookieOptions"'),
      'html includes CookieOptions export from security cookie module',
    );
  });
  it('links fetch init from the fetch globals module', async (t) => {
    const repoRoot = TEST_DIR + '/fetch-repo';
    await ensureDir(fs, repoRoot);
    await fs.symlink(REPO_DIR + '/js', repoRoot + '/js');
    const docsDir = repoRoot + '/docs';
    const run = await runCli(
      [
        'doc',
        'build',
        'js/globals/fetch.ts',
        'js/test/mock.ts',
        '--format',
        'both',
        '--title',
        'Fetch API',
      ],
      repoRoot,
    );
    t.equal(run.result.code, 0, 'fetch doc build exits successfully');
    t.equal(run.stderr, '', 'fetch doc build writes no stderr');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const fetchModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/fetch.ts');
    const mockModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/test/mock.ts');
    t.ok(fetchModule, 'fetch globals module is documented');
    t.ok(mockModule, 'mock module is documented');
    t.ok(
      fetchModule!.exports.some((item) => item.name === 'FetchInit'),
      'fetch module exports FetchInit',
    );
    t.equal(
      fetchModule!.exports.some((item) => item.name === 'fetchLater'),
      false,
      'fetch module does not export fetchLater',
    );
    t.equal(
      fetchModule!.exports.some((item) => item.name === 'FetchLaterResult'),
      false,
      'fetch module does not export FetchLaterResult',
    );
    t.equal(
      mockModule!.exports.some((item) => item.name === 'FetchInit'),
      false,
      'mock module does not export FetchInit',
    );
    t.ok(
      mockModule!.exports.some((item) => item.name === 'MockFetchInit'),
      'mock module exports MockFetchInit',
    );
    const html = await fs.readFile(docsDir + '/js/globals/fetch.html');
    t.ok(html.includes('id="fetch.FetchInit"'), 'fetch html includes FetchInit export');
    t.ok(
      html.includes('href="#fetch.FetchInit">FetchInit</a>'),
      'fetch signature links its local FetchInit',
    );
    t.equal(
      html.includes('mock.FetchInit'),
      false,
      'fetch html does not link init options to mock.FetchInit',
    );
    t.equal(html.includes('fetchLater'), false, 'fetch html omits fetchLater');
    await removeTree(fs, docsDir);
  });
  it('links FormData entry value from public signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(
      appDir + '/formdata.ts',
      await fs.readFile(REPO_DIR + '/js/globals/formdata.ts'),
    );
    const run = await runCli(
      ['doc', 'build', './formdata.ts', '--format', 'both', '--title', 'FormData API'],
      appDir,
    );
    t.equal(run.result.code, 0, 'formdata doc build exits successfully');
    t.equal(run.stderr, '', 'formdata doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/formdata.html');
    t.ok(
      html.includes('id="formdata.FormDataEntryValue"'),
      'html includes FormDataEntryValue export',
    );
    t.ok(
      html.includes('href="formdata.html#formdata.FormDataEntryValue">FormDataEntryValue</a>'),
      'html links FormDataEntryValue from signatures',
    );
    t.equal(
      html.includes('_createMultipartBoundary'),
      false,
      'html hides multipart boundary helper',
    );
  });
  it('links config value type from public signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(appDir + '/config.ts', await fs.readFile(REPO_DIR + '/js/config.ts'));
    const run = await runCli(
      ['doc', 'build', './config.ts', '--format', 'both', '--title', 'Config API'],
      appDir,
    );
    t.equal(run.result.code, 0, 'config doc build exits successfully');
    t.equal(run.stderr, '', 'config doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/config.html');
    t.ok(html.includes('id="config.ConfigValue"'), 'html includes ConfigValue export');
    t.ok(
      html.includes('href="#config.ConfigValue">ConfigValue</a>'),
      'html links ConfigValue from signatures',
    );
  });
  it('links Arrow base type from public type signatures', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(
      appDir + '/arrow-type.ts',
      await fs.readFile(REPO_DIR + '/js/data/arrow/type.ts'),
    );
    await fs.writeFile(
      appDir + '/arrow.ts',
      `/**
 * Public Arrow facade.
 */
export * from './arrow-type.ts';
`,
    );
    const run = await runCli(
      [
        'doc',
        'build',
        './arrow.ts',
        './arrow-type.ts',
        '--format',
        'both',
        '--title',
        'Arrow Type API',
      ],
      appDir,
    );
    t.equal(run.result.code, 0, 'Arrow type doc build exits successfully');
    t.equal(run.stderr, '', 'Arrow type doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/arrow.html');
    t.ok(html.includes('id="arrow.BaseType"'), 'html includes BaseType export');
    t.ok(
      html.includes('href="#arrow.BaseType">BaseType</a>'),
      'html links BaseType from concrete type signatures',
    );
  });
  it('links FileSystem from the public file module', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/file');
    await ensureDir(fs, appDir + '/internal/file');
    await fs.writeFile(appDir + '/file/fs.ts', await fs.readFile(REPO_DIR + '/js/file/fs.ts'));
    await fs.writeFile(
      appDir + '/internal/file/provider.ts',
      await fs.readFile(REPO_DIR + '/js/internal/file/provider.ts'),
    );
    await fs.writeFile(
      appDir + '/internal/file/stat.ts',
      await fs.readFile(REPO_DIR + '/js/internal/file/stat.ts'),
    );
    await fs.writeFile(
      appDir + '/internal/file/handle.ts',
      await fs.readFile(REPO_DIR + '/js/internal/file/handle.ts'),
    );
    await fs.writeFile(
      appDir + '/internal/file/entry.ts',
      await fs.readFile(REPO_DIR + '/js/internal/file/entry.ts'),
    );
    await fs.writeFile(
      appDir + '/internal/file/glob.ts',
      await fs.readFile(REPO_DIR + '/js/internal/file/glob.ts'),
    );
    const run = await runCli(
      [
        'doc',
        'build',
        './file/fs.ts',
        './internal/file/provider.ts',
        './internal/file/stat.ts',
        './internal/file/handle.ts',
        './internal/file/entry.ts',
        './internal/file/glob.ts',
        '--format',
        'both',
        '--title',
        'File API',
      ],
      appDir,
    );
    t.equal(run.result.code, 0, 'file doc build exits successfully');
    t.equal(run.stderr, '', 'file doc build writes no stderr');
    const html = await fs.readFile(docsDir + '/file/fs.html');
    t.ok(html.includes('id="fs.FileSystem"'), 'html includes FileSystem export');
    t.ok(
      html.includes('href="#fs.FileSystem">FileSystem</a>'),
      'html links FileSystem from DiskFileSystem signature',
    );
    for (const name of ['Stat', 'File', 'Entry', 'FileEntry', 'DirEntry']) {
      t.ok(html.includes(`id="fs.${name}"`), `html includes ${name} export`);
    }
    t.equal(
      await exists(fs, docsDir + '/internal/file/provider.html'),
      false,
      'internal provider module remains hidden',
    );
  });
  it('documents public stream reader and writer re-exports', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/js/internal');
    await fs.writeFile(appDir + '/js/stream.ts', await fs.readFile(REPO_DIR + '/js/stream.ts'));
    await fs.writeFile(
      appDir + '/js/internal/stream.ts',
      await fs.readFile(REPO_DIR + '/js/internal/stream.ts'),
    );
    const run = await runCli(
      [
        'doc',
        'build',
        './js/stream.ts',
        './js/internal/stream.ts',
        '--format',
        'both',
        '--title',
        'Stream API',
      ],
      appDir,
    );
    t.equal(run.result.code, 0, 'stream doc build exits successfully');
    t.equal(run.stderr, '', 'stream doc build writes no stderr');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const streamModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/stream.ts');
    t.ok(streamModule, 'public stream module is documented');
    for (const name of [
      'ReaderCloseCallback',
      'BytesReadOptions',
      'Reader',
      'BytesReader',
      'BufferedBytesReader',
      'Writer',
      'BytesWriter',
      'BufferedBytesWriter',
    ]) {
      t.ok(
        streamModule!.exports.some((item) => item.name === name),
        `stream module exports ${name}`,
      );
    }
    const markdown = await fs.readFile(docsDir + '/js/stream.md');
    for (const name of [
      'ReaderCloseCallback',
      'BytesReadOptions',
      'Reader',
      'BytesReader',
      'BufferedBytesReader',
      'Writer',
      'BytesWriter',
      'BufferedBytesWriter',
    ]) {
      t.ok(markdown.includes(`## ${name}`), `stream markdown includes ${name}`);
    }
    t.equal(
      await exists(fs, docsDir + '/js/internal/stream.md'),
      false,
      'internal stream module remains hidden by default',
    );
  });
  it('assigns unique doc ids to same-name type and value exports', async (t) => {
    const docsDir = appDir + '/docs';
    const jsonPath = docsDir + '/api.json';
    await removeTree(fs, docsDir);
    await fs.writeFile(
      appDir + '/same-name.ts',
      `/**
 * Same-name export fixture.
 */

/**
 * Runtime widget shape.
 */
export interface Widget {
readonly id: string;
}

/**
 * Runtime widget constructor.
 */
export const Widget = class WidgetImpl {
id = 'fixture';
};
`,
    );
    const run = await runCli(
      ['doc', 'build', './same-name.ts', '--format', 'both', '--title', 'Same Name API'],
      appDir,
    );
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.ok(run.stdout.includes('/docs/docs.db'), 'doc build reports sqlite index');
    const json = JSON.parse(await fs.readFile(jsonPath)) as DocJsonOutput;
    const moduleDoc = json.modules.find((item) => item.name === 'same-name')!;
    const widgets = moduleDoc.exports.filter((item) => item.name === 'Widget');
    const ids = widgets.map((item) => item.id);
    t.equal(widgets.length, 2, 'json keeps both same-name exports');
    t.equal(new Set(ids).size, ids.length, 'same-name exports have distinct symbol ids');
    t.ok(ids.includes('same-name.Widget'), 'first same-name export keeps the canonical symbol id');
    t.ok(
      ids.includes('same-name.Widget:const'),
      'second same-name export is disambiguated by kind',
    );
  });
  it('documents ambient declaration modules as separate API modules', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await fs.writeFile(
      appDir + '/runtime-builtins.d.ts',
      `/**
 * fino:ffi — Rust-backed native library loading.
 *
 * Use this module when a Fino script needs direct access to a system dynamic
 * library. Declarations in this fixture model Rust-provided synthetic modules
 * that do not have JavaScript source files.
 */
declare module 'fino:ffi' {
/**
 * Native symbol call signature.
 */
export interface NativeSymbolSpec {
  /**
   * Positional native parameter descriptors.
   */
  parameters?: readonly unknown[];
}

/**
 * Open a dynamic library and bind selected symbols.
 */
export function dlopen(path: string | null, symbols: Record<string, NativeSymbolSpec>): unknown;
}

/**
 * internal:process — Rust-backed process state.
 *
 * @internal
 */
declare module 'internal:process' {
/**
 * Operating system identifier.
 */
export const os: string;
}

declare global {
var ambientFixtureFlag: boolean | undefined;
}
`,
    );
    const run = await runCli(
      [
        'doc',
        'build',
        './runtime-builtins.d.ts',
        '--format',
        'both',
        '--title',
        'Runtime Builtins',
      ],
      appDir,
    );
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.ok(run.stdout.includes('/docs/ffi.md'), 'doc build reports ambient public markdown output');
    t.equal(
      run.stdout.includes('/docs/fino/ffi.md'),
      false,
      'doc build does not nest public fino declarations under a fino directory',
    );
    t.equal(
      await exists(fs, docsDir + '/runtime-builtins.d.ts.md'),
      false,
      'doc build does not emit a single declaration-file page',
    );
    t.equal(
      await exists(fs, docsDir + '/global.md'),
      false,
      'doc build does not emit declare global as an API module',
    );
    t.equal(
      await exists(fs, docsDir + '/internal/process.md'),
      false,
      'public doc build omits internal ambient modules',
    );
    const markdown = await fs.readFile(docsDir + '/ffi.md');
    t.ok(markdown.includes('# ffi'), 'markdown uses the canonical public module title');
    t.ok(
      markdown.includes('Rust-backed native library loading.'),
      'markdown includes the ambient module comment',
    );
    t.ok(markdown.includes('## dlopen'), 'markdown includes exported ambient functions');
    t.ok(markdown.includes('## NativeSymbolSpec'), 'markdown includes exported ambient interfaces');
    t.ok(markdown.includes('### parameters'), 'markdown includes ambient interface members');
    const html = await fs.readFile(docsDir + '/ffi.html');
    t.ok(html.includes('API Reference'), 'html sidebar includes the API reference root');
    t.equal(
      html.includes('docs-sidebar-directory">fino</div>'),
      false,
      'html sidebar does not group public fino declarations under a fino heading',
    );
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const ffi = json.modules.find((moduleDoc) => moduleDoc.name === 'ffi');
    t.ok(ffi, 'json includes public ambient module by canonical name');
    t.equal(
      ffi!.path,
      'runtime-builtins.d.ts',
      'json preserves the declaration file as the source path',
    );
    t.equal(ffi!.sourceModule, 'fino:ffi', 'json records the ambient source module specifier');
    t.ok(
      ffi!.exports.some((item) => item.name === 'dlopen'),
      'json includes ambient function export',
    );
    t.equal(
      json.modules.some((moduleDoc) => moduleDoc.name === 'internal:process'),
      false,
      'json excludes internal ambient modules by default',
    );
    const found = await runCli(['doc', 'search', 'dlopen'], appDir);
    t.equal(found.result.code, 0, 'doc search exits successfully');
    t.ok(
      found.stdout.includes('ffi.dlopen'),
      'sqlite search indexes ambient module symbols by canonical id',
    );
    await removeTree(fs, docsDir);
    const privateRun = await runCli(
      [
        'doc',
        'build',
        './runtime-builtins.d.ts',
        '--format',
        'markdown',
        '--include-private',
        '--title',
        'Runtime Builtins',
      ],
      appDir,
    );
    t.equal(privateRun.result.code, 0, 'private doc build exits successfully');
    t.equal(privateRun.stderr, '', 'private doc build writes no stderr');
    t.equal(
      await exists(fs, docsDir + '/internal/process.md'),
      true,
      'include-private emits internal ambient modules',
    );
  });
  it('merges declaration files into js tree docs when --types is provided', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/js');
    await fs.writeFile(
      appDir + '/js/public.ts',
      `/**
 * Public JS module.
 */

/**
 * Public JS value.
 */
export const value = 1;
`,
    );
    await fs.writeFile(
      appDir + '/runtime-builtins.d.ts',
      `/**
 * fino:ffi — Rust-backed native library loading.
 */
declare module 'fino:ffi' {
/**
 * Open a dynamic library.
 */
export function dlopen(path: string | null, symbols: Record<string, unknown>): unknown;
}
`,
    );
    const withoutTypes = await runCli(['doc', 'build', '--format', 'both', 'js'], appDir);
    t.equal(withoutTypes.result.code, 0, 'doc build without --types exits successfully');
    t.equal(withoutTypes.stderr, '', 'doc build without --types writes no stderr');
    t.ok(
      withoutTypes.stdout.includes('/docs/public.md'),
      'doc build reports docs for files under the js input root',
    );
    t.equal(
      withoutTypes.stdout.includes('/docs/js/public.md'),
      false,
      'doc build does not nest js input-root docs under a js directory',
    );
    t.equal(
      withoutTypes.stdout.includes('/docs/ffi.md'),
      false,
      'doc build does not report declaration docs without --types',
    );
    let json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    t.ok(
      json.modules.some((moduleDoc) => moduleDoc.path === 'js/public.ts'),
      'json includes js tree module without --types',
    );
    t.equal(
      json.modules.some((moduleDoc) => moduleDoc.name === 'ffi'),
      false,
      'json omits runtime declaration module without --types',
    );
    await removeTree(fs, docsDir);
    const run = await runCli(
      ['doc', 'build', '--format', 'both', '--types', 'runtime-builtins.d.ts', 'js'],
      appDir,
    );
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.ok(
      run.stdout.includes('/docs/public.md'),
      'doc build reports docs for files under the js input root',
    );
    t.equal(
      run.stdout.includes('/docs/js/public.md'),
      false,
      'doc build does not nest js input-root docs under a js directory',
    );
    t.ok(run.stdout.includes('/docs/ffi.md'), 'doc build reports root runtime declaration docs');
    t.equal(
      run.stdout.includes('/docs/fino/ffi.md'),
      false,
      'doc build does not nest declaration docs under a fino directory',
    );
    const publicHtml = await fs.readFile(docsDir + '/public.html');
    t.equal(
      publicHtml.includes('docs-sidebar-directory">js</div>'),
      false,
      'sidebar does not group js input-root modules under a js heading',
    );
    json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    t.ok(
      json.modules.some((moduleDoc) => moduleDoc.path === 'js/public.ts'),
      'json includes js tree module',
    );
    t.ok(
      json.modules.some((moduleDoc) => moduleDoc.name === 'ffi'),
      'json includes runtime declaration module',
    );
    const found = await runCli(['doc', 'search', 'dlopen'], appDir);
    t.equal(found.result.code, 0, 'doc search exits successfully');
    t.ok(
      found.stdout.includes('ffi.dlopen'),
      'search finds runtime declaration symbols after js build',
    );
  });
  it('keeps ambient module names when a source file shares the basename', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/js/internal');
    await fs.writeFile(
      appDir + '/js/internal/ffi.ts',
      `/**
 * Internal ffi helpers.
 *
 * @internal
 */

/**
 * Internal helper value.
 */
export const helper = 1;
`,
    );
    await fs.writeFile(
      appDir + '/runtime-builtins.d.ts',
      `/**
 * fino:ffi — Rust-backed native library loading.
 */
declare module 'fino:ffi' {
/**
 * Open a dynamic library.
 */
export function dlopen(path: string | null, symbols: Record<string, unknown>): unknown;
}
`,
    );
    const run = await runCli(
      ['doc', 'build', '--format', 'markdown', '--types', 'runtime-builtins.d.ts', 'js'],
      appDir,
    );
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const ffi = json.modules.find((moduleDoc) => moduleDoc.sourceModule === 'fino:ffi');
    t.ok(ffi, 'json keeps the ambient source module specifier');
    t.equal(ffi?.name, 'ffi', 'ambient module keeps its specifier-derived name');
    t.equal(
      json.modules.some((moduleDoc) => moduleDoc.name.includes('runtime-builtins')),
      false,
      'no module is renamed after the declaration file',
    );
    const markdown = await fs.readFile(docsDir + '/ffi.md');
    t.ok(markdown.includes('# ffi'), 'markdown titles the ambient module by its canonical name');
    await removeTree(fs, appDir + '/js/internal');
  });
});
