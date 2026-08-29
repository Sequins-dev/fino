/** Documentation modules integration tests. */
import { after, before, describe, it } from 'fino:test/test';
import {
  createDocTestFixture,
  type DocTestFixture,
  removeDocTestFixture,
  type DocJsonExport,
  type DocJsonOutput,
  REPO_DIR,
  TEST_DIR,
  ensureDir,
  exists,
  removeTree,
  runCli,
} from './doc-test-helpers.ts';

describe('fino doc: modules', () => {
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
  it('documents re-exports from hidden modules and links documented source modules', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    const run = await runCli(
      [
        'doc',
        'build',
        './facade.ts',
        './hidden-source.ts',
        './hidden-star.ts',
        './public-source.ts',
        './public-star.ts',
        '--format',
        'html',
        '--title',
        'Facade Docs',
      ],
      appDir,
    );
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.equal(
      await exists(fs, docsDir + '/hidden-source.html'),
      false,
      'internal source module remains hidden by default',
    );
    const facadeHtml = await fs.readFile(docsDir + '/facade.html');
    t.ok(
      facadeHtml.includes('Hidden class docs copied into public facades.'),
      'html inlines class docs from hidden source module',
    );
    t.ok(
      facadeHtml.includes('Hidden value docs copied with the class.'),
      'html inlines members from hidden source module',
    );
    t.ok(
      facadeHtml.includes('Hidden options docs copied into public facades.'),
      'html inlines type docs from hidden source module',
    );
    t.ok(
      facadeHtml.includes('Hidden star docs copied into public facades.'),
      'html inlines star re-exports from hidden source module',
    );
    t.ok(
      facadeHtml.includes('Star value docs.'),
      'html inlines star re-export members from hidden source module',
    );
    t.equal(
      facadeHtml.includes('privateHelper'),
      false,
      'html does not leak internal source symbols through re-exports',
    );
    t.equal(
      facadeHtml.includes('privateStar'),
      false,
      'html does not leak internal source symbols through star re-exports',
    );
    t.ok(
      facadeHtml.includes(
        'Re-exported from <a href="public-source.html#public-source.publicTarget">public-source.publicTarget</a>.',
      ),
      'html links re-exports from documented public modules',
    );
    t.ok(
      facadeHtml.includes(
        'Re-exported from <a href="public-star.html#public-star.PublicStar">public-star.PublicStar</a>.',
      ),
      'html links star re-exports from documented public modules',
    );
    t.equal(
      facadeHtml.includes('Public target docs stay canonical in the source module.'),
      false,
      'html does not duplicate public source docs in the facade',
    );
    t.equal(
      facadeHtml.includes('Public star docs stay canonical in the source module.'),
      false,
      'html does not duplicate public star docs in the facade',
    );
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const facade = json.modules.find((moduleDoc) => moduleDoc.name === 'facade')!;
    const publicSource = json.modules.find((moduleDoc) => moduleDoc.name === 'public-source')!;
    t.ok(facade, 'json includes facade module');
    t.ok(publicSource, 'json includes public source module');
    t.equal(
      json.modules.some((moduleDoc) => moduleDoc.name === 'hidden-source'),
      false,
      'json excludes hidden source module by default',
    );
    const publicThing = facade.exports.find((item) => item.name === 'PublicThing')!;
    const hiddenOptions = facade.exports.find((item) => item.name === 'HiddenOptions')!;
    const linkedTarget = facade.exports.find((item) => item.name === 'linkedTarget')!;
    const starThing = facade.exports.find((item) => item.name === 'StarThing')!;
    const publicStar = facade.exports.find((item) => item.name === 'PublicStar')!;
    t.ok(
      publicThing.doc!.text.includes('Hidden class docs copied'),
      'json inlines hidden class docs under facade alias',
    );
    t.equal(
      publicThing.members.some((member) => member.name === 'value'),
      true,
      'json inlines hidden class members under facade alias',
    );
    t.ok(
      hiddenOptions.doc!.text.includes('Hidden options docs copied'),
      'json inlines hidden type docs under facade alias',
    );
    t.ok(
      starThing.doc!.text.includes('Hidden star docs copied'),
      'json inlines hidden star export docs',
    );
    t.equal(linkedTarget.reExport?.mode, 'link', 'json marks public-source re-export as linked');
    t.equal(
      linkedTarget.reExport?.sourceId,
      'public-source.publicTarget',
      'json records linked source symbol id',
    );
    t.equal(publicStar.reExport?.mode, 'link', 'json marks public star re-export as linked');
    t.equal(
      publicStar.reExport?.sourceId,
      'public-star.PublicStar',
      'json records linked star source symbol id',
    );
    await removeTree(fs, docsDir);
    const privateRun = await runCli(
      [
        'doc',
        'build',
        './facade.ts',
        './hidden-source.ts',
        './hidden-star.ts',
        './public-source.ts',
        './public-star.ts',
        '--format',
        'html',
        '--include-private',
        '--title',
        'Facade Docs',
      ],
      appDir,
    );
    t.equal(privateRun.result.code, 0, 'private doc build exits successfully');
    const privateFacadeHtml = await fs.readFile(docsDir + '/facade.html');
    t.ok(
      await exists(fs, docsDir + '/hidden-source.html'),
      'include-private emits hidden source page',
    );
    t.ok(
      privateFacadeHtml.includes(
        'Re-exported from <a href="hidden-source.html#hidden-source.HiddenThing">hidden-source.HiddenThing</a>.',
      ),
      'include-private links internal-source re-exports once the source page exists',
    );
    t.equal(
      privateFacadeHtml.includes('Hidden class docs copied into public facades.'),
      false,
      'include-private does not duplicate hidden source docs in facade',
    );
  });
  it('documents moved web globals without exposing internal import specifiers', async (t) => {
    const repoRoot = TEST_DIR + '/web-globals-repo';
    await ensureDir(fs, repoRoot);
    await fs.symlink(REPO_DIR + '/js', repoRoot + '/js');
    const docsDir = repoRoot + '/docs';
    const run = await runCli(
      [
        'doc',
        'build',
        'js/globals/fetch.ts',
        'js/globals/abort.ts',
        'js/globals/blob.ts',
        'js/globals/console.ts',
        'js/globals/crypto.ts',
        'js/globals/encoding.ts',
        'js/globals/eventtarget.ts',
        'js/globals/eventsource.ts',
        'js/globals/formdata.ts',
        'js/globals/messaging.ts',
        'js/globals/url.ts',
        'js/globals/websocket.ts',
        'js/globals/webtransport.ts',
        'js/net/http/websocket.ts',
        'js/net/http/webtransport.ts',
        'js/internal/tty/bindings.ts',
        '--format',
        'markdown',
        '--title',
        'Globals Docs',
      ],
      repoRoot,
    );
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const fetchModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/fetch.ts');
    const abortModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/abort.ts');
    const blobModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/blob.ts');
    const consoleModule = json.modules.find(
      (moduleDoc) => moduleDoc.path === 'js/globals/console.ts',
    );
    const cryptoModule = json.modules.find(
      (moduleDoc) => moduleDoc.path === 'js/globals/crypto.ts',
    );
    const encodingModule = json.modules.find(
      (moduleDoc) => moduleDoc.path === 'js/globals/encoding.ts',
    );
    const eventTargetModule = json.modules.find(
      (moduleDoc) => moduleDoc.path === 'js/globals/eventtarget.ts',
    );
    const eventSourceModule = json.modules.find(
      (moduleDoc) => moduleDoc.path === 'js/globals/eventsource.ts',
    );
    const formDataModule = json.modules.find(
      (moduleDoc) => moduleDoc.path === 'js/globals/formdata.ts',
    );
    const messagingModule = json.modules.find(
      (moduleDoc) => moduleDoc.path === 'js/globals/messaging.ts',
    );
    const urlModule = json.modules.find((moduleDoc) => moduleDoc.path === 'js/globals/url.ts');
    const webSocketModule = json.modules.find(
      (moduleDoc) => moduleDoc.path === 'js/globals/websocket.ts',
    );
    const webTransportModule = json.modules.find(
      (moduleDoc) => moduleDoc.path === 'js/globals/webtransport.ts',
    );
    const httpWebSocketModule = json.modules.find(
      (moduleDoc) => moduleDoc.path === 'js/net/http/websocket.ts',
    );
    const httpWebTransportModule = json.modules.find(
      (moduleDoc) => moduleDoc.path === 'js/net/http/webtransport.ts',
    );
    t.ok(fetchModule, 'moved fetch globals module is documented by default');
    t.ok(abortModule, 'abort globals module is documented by default');
    t.ok(blobModule, 'blob globals module is documented by default');
    t.ok(consoleModule, 'console globals module is documented by default');
    t.ok(cryptoModule, 'crypto globals module is documented by default');
    t.ok(encodingModule, 'encoding globals module is documented by default');
    t.ok(eventTargetModule, 'eventtarget globals module is documented by default');
    t.ok(eventSourceModule, 'eventsource globals module is documented by default');
    t.ok(formDataModule, 'formdata globals module is documented by default');
    t.ok(messagingModule, 'messaging globals module is documented by default');
    t.ok(urlModule, 'url globals module is documented by default');
    t.ok(webSocketModule, 'websocket globals module is documented by default');
    t.ok(webTransportModule, 'webtransport globals module is documented by default');
    t.ok(httpWebSocketModule, 'http websocket module is documented by default');
    t.ok(httpWebTransportModule, 'http webtransport module is documented by default');
    t.ok(
      fetchModule!.exports.some((item) => item.name === 'FetchInit'),
      'fetch globals include FetchInit export',
    );
    t.equal(
      fetchModule!.exports.some((item) => item.name === 'fetchLater'),
      false,
      'fetch globals do not export fetchLater',
    );
    t.equal(
      fetchModule!.exports.some((item) => item.name === 'FetchLaterResult'),
      false,
      'fetch globals do not export FetchLaterResult',
    );
    t.ok(
      abortModule!.exports.some((item) => item.name === 'AbortSignal'),
      'abort globals include AbortSignal export',
    );
    t.ok(
      abortModule!.exports.some((item) => item.name === 'AbortController'),
      'abort globals include AbortController export',
    );
    for (const name of ['BlobPart', 'BlobOptions', 'FileOptions', 'FileReaderHandler']) {
      t.ok(
        blobModule!.exports.some((item) => item.name === name),
        `blob globals include ${name} export`,
      );
    }
    t.ok(
      consoleModule!.exports.some((item) => item.name === 'Console'),
      'console globals include Console export',
    );
    t.equal(
      consoleModule!.exports.some((item) => item.name === 'ConsoleCaptureRecord'),
      false,
      'console capture records stay internal',
    );
    t.equal(
      consoleModule!.exports.some((item) => item.name === 'ConsoleCaptureSink'),
      false,
      'console capture sinks stay internal',
    );
    for (const name of [
      'Crypto',
      'SubtleCrypto',
      'CryptoKey',
      'KeyAlgorithm',
      'KeyFormat',
      'KeyUsage',
      'BufferSource',
    ]) {
      t.ok(
        cryptoModule!.exports.some((item) => item.name === name),
        `crypto globals include ${name} export`,
      );
    }
    t.equal(
      encodingModule!.exports.some((item) => item.name === 'encodeUtf8'),
      false,
      'encoding globals do not export encodeUtf8',
    );
    t.equal(
      encodingModule!.exports.some((item) => item.name === 'decodeUtf8'),
      false,
      'encoding globals do not export decodeUtf8',
    );
    for (const name of ['AddEventListenerOptions', 'EventCallback']) {
      t.ok(
        eventTargetModule!.exports.some((item) => item.name === name),
        `eventtarget globals include ${name} export`,
      );
    }
    t.ok(
      formDataModule!.exports.some((item) => item.name === 'FormData'),
      'formdata globals include FormData export',
    );
    t.ok(
      formDataModule!.exports.some((item) => item.name === 'FormDataEntryValue'),
      'formdata globals include FormDataEntryValue export',
    );
    t.equal(
      formDataModule!.exports.some((item) => item.name === '_createMultipartBoundary'),
      false,
      'formdata globals do not export multipart boundary helper',
    );
    for (const name of ['MessageEvent', 'MessagePort', 'MessageChannel']) {
      t.ok(
        messagingModule!.exports.some((item) => item.name === name),
        `messaging globals include ${name} export`,
      );
    }
    t.equal(
      messagingModule!.exports.some((item) => item.name === 'ThreadPort'),
      false,
      'messaging globals do not export ThreadPort',
    );
    t.equal(
      messagingModule!.exports.some((item) => item.name === 'BaseTransportPort'),
      false,
      'messaging globals do not export BaseTransportPort',
    );
    t.ok(
      urlModule!.exports.some((item) => item.name === 'URL'),
      'url globals include URL export',
    );
    t.ok(
      urlModule!.exports.some((item) => item.name === 'URLSearchParams'),
      'url globals include URLSearchParams export',
    );
    for (const name of ['WebSocket', 'CloseEvent', 'ErrorEvent', 'MessageEvent']) {
      t.ok(
        webSocketModule!.exports.some((item) => item.name === name),
        `websocket globals include ${name} export`,
      );
    }
    for (const name of [
      'WebSocketConnection',
      'WebSocketAcceptOptions',
      'WebSocketConnectOptions',
      'WebSocketError',
    ]) {
      t.equal(
        webSocketModule!.exports.some((item) => item.name === name),
        false,
        `websocket globals do not export ${name}`,
      );
    }
    for (const name of [
      'WebSocketConnection',
      'WebSocketAcceptOptions',
      'WebSocketConnectOptions',
      'WebSocketError',
    ]) {
      t.ok(
        httpWebSocketModule!.exports.some((item) => item.name === name),
        `http websocket module exports ${name}`,
      );
    }
    for (const name of [
      'WebTransport',
      'WebTransportDatagramDuplexStream',
      'WebTransportOptions',
    ]) {
      t.ok(
        webTransportModule!.exports.some((item) => item.name === name),
        `webtransport globals include ${name} export`,
      );
    }
    for (const name of [
      'Http3WebTransportInit',
      '_fromHttp3WebTransport',
      '_acceptIncomingQuicWebTransportStream',
    ]) {
      t.equal(
        webTransportModule!.exports.some((item) => item.name === name),
        false,
        `webtransport globals do not export ${name}`,
      );
    }
    t.ok(
      httpWebTransportModule!.exports.some((item) => item.name === 'WebTransport'),
      'http webtransport module exports WebTransport',
    );
    t.equal(
      json.modules.some((moduleDoc) => moduleDoc.path === 'js/internal/tty/bindings.ts'),
      false,
      'internal tty bindings module is hidden by default',
    );
    const markdown = await fs.readFile(docsDir + '/js/globals/fetch.md');
    const abortMarkdown = await fs.readFile(docsDir + '/js/globals/abort.md');
    const blobMarkdown = await fs.readFile(docsDir + '/js/globals/blob.md');
    const consoleMarkdown = await fs.readFile(docsDir + '/js/globals/console.md');
    const cryptoMarkdown = await fs.readFile(docsDir + '/js/globals/crypto.md');
    const encodingMarkdown = await fs.readFile(docsDir + '/js/globals/encoding.md');
    const eventTargetMarkdown = await fs.readFile(docsDir + '/js/globals/eventtarget.md');
    const eventSourceMarkdown = await fs.readFile(docsDir + '/js/globals/eventsource.md');
    const formDataMarkdown = await fs.readFile(docsDir + '/js/globals/formdata.md');
    const messagingMarkdown = await fs.readFile(docsDir + '/js/globals/messaging.md');
    const urlMarkdown = await fs.readFile(docsDir + '/js/globals/url.md');
    const webSocketMarkdown = await fs.readFile(docsDir + '/js/globals/websocket.md');
    const webTransportMarkdown = await fs.readFile(docsDir + '/js/globals/webtransport.md');
    t.equal(
      markdown.includes('internal:globals/'),
      false,
      'generated module docs do not advertise internal globals specifiers',
    );
    t.ok(markdown.includes('## FetchInit'), 'fetch markdown includes FetchInit');
    t.equal(markdown.includes('fetchLater'), false, 'fetch markdown omits fetchLater');
    t.equal(markdown.includes('FetchLaterResult'), false, 'fetch markdown omits FetchLaterResult');
    t.equal(
      abortMarkdown.includes('No exported declarations found.'),
      false,
      'abort globals page includes public exports',
    );
    t.ok(abortMarkdown.includes('## AbortSignal'), 'abort markdown includes AbortSignal');
    t.ok(abortMarkdown.includes('## AbortController'), 'abort markdown includes AbortController');
    t.equal(
      blobMarkdown.includes('No exported declarations found.'),
      false,
      'blob globals page includes public exports',
    );
    for (const name of ['BlobPart', 'BlobOptions', 'FileOptions', 'FileReaderHandler']) {
      t.ok(blobMarkdown.includes(`## ${name}`), `blob markdown includes ${name}`);
    }
    t.equal(
      consoleMarkdown.includes('No exported declarations found.'),
      false,
      'console globals page includes public exports',
    );
    t.ok(consoleMarkdown.includes('## Console'), 'console markdown includes Console');
    t.ok(consoleMarkdown.includes('### log'), 'console markdown includes log method docs');
    t.ok(consoleMarkdown.includes('### timeEnd'), 'console markdown includes timer method docs');
    t.equal(
      consoleMarkdown.includes('internal:globals/'),
      false,
      'console markdown does not advertise internal globals specifiers',
    );
    t.equal(
      consoleMarkdown.includes('## Contributing'),
      false,
      'console markdown omits contributor notes',
    );
    t.equal(
      consoleMarkdown.includes('ConsoleCaptureRecord'),
      false,
      'console markdown hides internal capture records',
    );
    t.equal(
      cryptoMarkdown.includes('No exported declarations found.'),
      false,
      'crypto globals page includes public exports',
    );
    t.ok(cryptoMarkdown.includes('## Crypto'), 'crypto markdown includes Crypto interface');
    t.ok(
      cryptoMarkdown.includes('## SubtleCrypto'),
      'crypto markdown includes SubtleCrypto interface',
    );
    t.ok(cryptoMarkdown.includes('## CryptoKey'), 'crypto markdown includes CryptoKey');
    t.ok(cryptoMarkdown.includes('### digest'), 'crypto markdown includes subtle digest docs');
    t.ok(
      cryptoMarkdown.includes('### getRandomValues'),
      'crypto markdown includes getRandomValues docs',
    );
    t.equal(
      encodingMarkdown.includes('## encodeUtf8'),
      false,
      'encoding markdown omits internal encodeUtf8 helper',
    );
    t.equal(
      encodingMarkdown.includes('## decodeUtf8'),
      false,
      'encoding markdown omits internal decodeUtf8 helper',
    );
    t.ok(
      eventTargetMarkdown.includes('## AddEventListenerOptions'),
      'eventtarget markdown includes AddEventListenerOptions',
    );
    t.ok(
      eventTargetMarkdown.includes('## EventCallback'),
      'eventtarget markdown includes EventCallback',
    );
    t.equal(
      eventSourceMarkdown.includes('EventSourceReader'),
      false,
      'eventsource globals markdown omits eventstream reader docs',
    );
    t.equal(
      eventSourceMarkdown.includes('EventSourceWriter'),
      false,
      'eventsource globals markdown omits eventstream writer docs',
    );
    t.ok(formDataMarkdown.includes('## FormData'), 'formdata markdown includes FormData');
    t.ok(
      formDataMarkdown.includes('## FormDataEntryValue'),
      'formdata markdown includes FormDataEntryValue',
    );
    t.equal(
      formDataMarkdown.includes('_createMultipartBoundary'),
      false,
      'formdata markdown hides multipart boundary helper',
    );
    t.ok(messagingMarkdown.includes('## MessagePort'), 'messaging markdown includes MessagePort');
    t.ok(
      messagingMarkdown.includes('## MessageChannel'),
      'messaging markdown includes MessageChannel',
    );
    t.equal(
      messagingMarkdown.includes('## ThreadPort'),
      false,
      'messaging markdown omits ThreadPort',
    );
    t.equal(
      messagingMarkdown.includes('## BaseTransportPort'),
      false,
      'messaging markdown omits BaseTransportPort',
    );
    t.ok(urlMarkdown.includes('## URL'), 'url markdown includes URL');
    t.ok(urlMarkdown.includes('## URLSearchParams'), 'url markdown includes URLSearchParams');
    t.ok(webSocketMarkdown.includes('## WebSocket'), 'websocket markdown includes WebSocket');
    t.ok(webSocketMarkdown.includes('## CloseEvent'), 'websocket markdown includes CloseEvent');
    t.ok(webSocketMarkdown.includes('## ErrorEvent'), 'websocket markdown includes ErrorEvent');
    for (const name of [
      'WebSocketConnection',
      'WebSocketAcceptOptions',
      'WebSocketConnectOptions',
      'WebSocketError',
    ]) {
      t.equal(webSocketMarkdown.includes(`## ${name}`), false, `websocket markdown omits ${name}`);
    }
    t.ok(
      webTransportMarkdown.includes('## WebTransport'),
      'webtransport markdown includes WebTransport',
    );
    t.ok(
      webTransportMarkdown.includes('## WebTransportDatagramDuplexStream'),
      'webtransport markdown includes datagram constructor',
    );
    for (const name of [
      'Http3WebTransportInit',
      '_fromHttp3WebTransport',
      '_acceptIncomingQuicWebTransportStream',
      '_fromHttp3',
      '_acceptIncomingQuicStream',
      '_push',
      '_close',
      '_error',
      '_stats',
    ]) {
      t.equal(webTransportMarkdown.includes(name), false, `webtransport markdown omits ${name}`);
    }
    t.equal(
      await exists(fs, docsDir + '/js/internal/tty/bindings.md'),
      false,
      'internal tty bindings markdown is not emitted by default',
    );
    await removeTree(fs, docsDir);
  });
  it('links OpenTelemetry facade re-exports from public signal modules', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, appDir + '/opentelemetry');
    await ensureDir(fs, appDir + '/internal/opentelemetry');
    await fs.writeFile(
      appDir + '/opentelemetry.ts',
      `/**
 * OpenTelemetry facade docs.
 */

export { getTracerProvider, Span } from './opentelemetry/traces.ts';
export { getMeterProvider, Counter } from './opentelemetry/metrics.ts';
export { getLoggerProvider, SeverityNumber } from './opentelemetry/logs.ts';
export { OtelSDK, InMemoryExporter } from './opentelemetry/sdk.ts';
`,
    );
    await fs.writeFile(
      appDir + '/opentelemetry/traces.ts',
      `/**
 * Trace signal docs.
 */

/**
 * Detailed span docs should stay on the traces page.
 */
export class Span {}

/**
 * Detailed tracer provider docs should stay on the traces page.
 */
export function getTracerProvider(): unknown {
return {};
}
`,
    );
    await fs.writeFile(
      appDir + '/opentelemetry/metrics.ts',
      `/**
 * Metric signal docs.
 */

/**
 * Detailed counter docs should stay on the metrics page.
 */
export class Counter {}

/**
 * Detailed meter provider docs should stay on the metrics page.
 */
export function getMeterProvider(): unknown {
return {};
}
`,
    );
    await fs.writeFile(
      appDir + '/opentelemetry/logs.ts',
      `/**
 * Log signal docs.
 */

/**
 * Detailed severity docs should stay on the logs page.
 */
export enum SeverityNumber {
INFO = 9,
}

/**
 * Detailed logger provider docs should stay on the logs page.
 */
export function getLoggerProvider(): unknown {
return {};
}
`,
    );
    await fs.writeFile(
      appDir + '/opentelemetry/sdk.ts',
      `/**
 * SDK docs.
 */

/**
 * Detailed SDK docs should stay on the sdk page.
 */
export class OtelSDK {}

/**
 * Detailed exporter docs should stay on the sdk page.
 */
export class InMemoryExporter {}
`,
    );
    await fs.writeFile(
      appDir + '/internal/opentelemetry/traces.ts',
      `/**
 * Internal trace source.
 *
 * @internal
 */
export const internalTrace = true;
`,
    );
    await fs.writeFile(
      appDir + '/internal/opentelemetry/metrics.ts',
      `/**
 * Internal metric source.
 *
 * @internal
 */
export const internalMetric = true;
`,
    );
    await fs.writeFile(
      appDir + '/internal/opentelemetry/logs.ts',
      `/**
 * Internal log source.
 *
 * @internal
 */
export const internalLog = true;
`,
    );
    await fs.writeFile(
      appDir + '/internal/opentelemetry/sdk.ts',
      `/**
 * Internal SDK source.
 *
 * @internal
 */
export const internalSdk = true;
`,
    );
    const run = await runCli(
      [
        'doc',
        'build',
        './opentelemetry.ts',
        './opentelemetry/traces.ts',
        './opentelemetry/metrics.ts',
        './opentelemetry/logs.ts',
        './opentelemetry/sdk.ts',
        './internal/opentelemetry/traces.ts',
        './internal/opentelemetry/metrics.ts',
        './internal/opentelemetry/logs.ts',
        './internal/opentelemetry/sdk.ts',
        '--format',
        'html',
        '--title',
        'OpenTelemetry Docs',
      ],
      appDir,
    );
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.ok(await exists(fs, docsDir + '/opentelemetry/traces.html'), 'traces page is emitted');
    t.ok(await exists(fs, docsDir + '/opentelemetry/metrics.html'), 'metrics page is emitted');
    t.ok(await exists(fs, docsDir + '/opentelemetry/logs.html'), 'logs page is emitted');
    t.ok(await exists(fs, docsDir + '/opentelemetry/sdk.html'), 'sdk page is emitted');
    const facadeHtml = await fs.readFile(docsDir + '/opentelemetry.html');
    t.ok(
      facadeHtml.includes(
        'Re-exported from <a href="opentelemetry/traces.html#opentelemetry-traces.Span">opentelemetry/traces.Span</a>.',
      ),
      'root links trace class re-export',
    );
    t.ok(
      facadeHtml.includes(
        'Re-exported from <a href="opentelemetry/metrics.html#opentelemetry-metrics.Counter">opentelemetry/metrics.Counter</a>.',
      ),
      'root links metric class re-export',
    );
    t.ok(
      facadeHtml.includes(
        'Re-exported from <a href="opentelemetry/logs.html#opentelemetry-logs.SeverityNumber">opentelemetry/logs.SeverityNumber</a>.',
      ),
      'root links log enum re-export',
    );
    t.ok(
      facadeHtml.includes(
        'Re-exported from <a href="opentelemetry/sdk.html#opentelemetry-sdk.OtelSDK">opentelemetry/sdk.OtelSDK</a>.',
      ),
      'root links sdk class re-export',
    );
    t.equal(
      facadeHtml.includes('Detailed span docs should stay on the traces page.'),
      false,
      'root does not inline trace detail docs',
    );
    t.equal(
      facadeHtml.includes('Detailed counter docs should stay on the metrics page.'),
      false,
      'root does not inline metric detail docs',
    );
    t.equal(
      facadeHtml.includes('Detailed severity docs should stay on the logs page.'),
      false,
      'root does not inline log detail docs',
    );
    t.equal(
      facadeHtml.includes('Detailed SDK docs should stay on the sdk page.'),
      false,
      'root does not inline sdk detail docs',
    );
  });
  it('documents exported object literal members and cleans stale output', async (t) => {
    const docsDir = appDir + '/docs';
    await removeTree(fs, docsDir);
    await ensureDir(fs, docsDir);
    await fs.writeFile(docsDir + '/stale.html', '<p>old docs</p>');
    const run = await runCli(
      ['doc', 'build', './surface.ts', '--format', 'both', '--title', 'Surface API'],
      appDir,
    );
    t.equal(run.result.code, 0, 'doc build exits successfully');
    t.equal(run.stderr, '', 'doc build writes no stderr');
    t.equal(
      await exists(fs, docsDir + '/stale.html'),
      false,
      'doc build removes stale generated html',
    );
    const html = await fs.readFile(docsDir + '/surface.html');
    t.ok(html.includes('<ul>'), 'html renders markdown list from module comment');
    t.ok(html.includes('<li>surface.run(input)</li>'), 'html keeps module call list readable');
    t.ok(
      html.includes('<h3><code><span class="tok-keyword">const</span> surface</code></h3>'),
      'html renders exported object signature without export prefix',
    );
    t.ok(html.includes('id="surface.surface.run"'), 'html documents exported object method');
    t.ok(
      html.includes(
        'run(input: <span class="tok-keyword">string</span>): <span class="tok-keyword">string</span>',
      ),
      'html renders object method type signature',
    );
    t.ok(
      html.includes(
        'configure(options: { enabled: <span class="tok-keyword">boolean</span> }): { enabled: <span class="tok-keyword">boolean</span> }',
      ),
      'html keeps short object type annotations compact',
    );
    t.ok(html.includes('Run with a string input.'), 'html includes object method docs');
    t.ok(
      html.includes('id="surface.surface.nested.ping"'),
      'html follows exported object references to local object members',
    );
    t.ok(html.includes('Ping a named target.'), 'html includes nested object member docs');
    t.equal(html.includes('localHelper'), false, 'html excludes unexported local helpers');
    t.equal(
      html.includes('<span class="tok-keyword">export</span>'),
      false,
      'html omits redundant export prefix',
    );
    t.equal(html.includes('Propertys'), false, 'html uses grammatical group labels');
    const json = JSON.parse(await fs.readFile(docsDir + '/api.json')) as DocJsonOutput;
    const moduleDoc = json.modules[0]!;
    const surface = moduleDoc.exports.find((item: DocJsonExport) => item.name === 'surface')!;
    t.ok(surface, 'json includes exported object');
    t.equal(moduleDoc.path, 'surface.ts', 'json stores project-relative module path');
    t.equal(surface.signature, 'const surface', 'json signature omits export prefix');
    t.equal(
      surface.members.some((member) => member.name === 'run' && member.kind === 'method'),
      true,
      'json includes exported object method',
    );
    t.equal(
      surface.members.some(
        (member) =>
          member.name === 'configure' &&
          member.signature === 'configure(options: { enabled: boolean }): { enabled: boolean }',
      ),
      true,
      'json keeps short object type annotations compact',
    );
    t.equal(
      surface.members.some((member) => member.name === 'nested.ping'),
      true,
      'json includes nested referenced object method',
    );
    t.equal(
      moduleDoc.exports.some((item) => item.name === 'localHelper'),
      false,
      'json excludes unexported local helper',
    );
    const mode = moduleDoc.exports.find((item: DocJsonExport) => item.name === 'Mode')!;
    t.ok(mode, 'json includes exported enum');
    t.equal(
      mode.signature!.includes('export function afterEnum'),
      false,
      'enum signature stops before following exports',
    );
    t.ok(mode.signature!.includes('\n'), 'json records formatted multiline enum signature');
    t.equal(
      mode.signature!.includes('Internal enum member docs'),
      false,
      'json strips comments from enum signatures',
    );
    const found = await runCli(['doc', 'search', 'nested ping'], appDir);
    t.equal(found.stderr, '', 'doc search writes no stderr');
    t.equal(found.result.code, 0, 'doc search exits successfully');
    t.ok(
      found.stdout.includes('surface.surface.nested.ping'),
      'search finds nested exported object member',
    );
    t.equal(found.stdout.includes('export const'), false, 'search signatures omit export prefix');
  });
});
