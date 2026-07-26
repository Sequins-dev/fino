/**
 * Contract tests for the web globals registry.
 *
 * The bootstrap imports `internal:globals/global` and installs each public
 * export on `globalThis`. Internal helper exports may stay module-only.
 */
import { describe, it } from 'fino:test/test';
import * as globals from 'internal:globals/global';
import { fetch as internalFetch } from 'internal:globals/fetch';
const moduleRecord = globals as Record<string, unknown>;
const globalRecord = globalThis as Record<string, unknown>;
describe('internal:globals/global registry', () => {
  it('keeps internal:globals leaf specifiers resolvable', (t) => {
    t.equal(
      internalFetch,
      globalThis.fetch,
      'internal:globals/fetch resolves to the installed fetch implementation',
    );
  });
  it('aliases self to globalThis and exposes a minimal navigator', (t) => {
    t.equal(globalThis.self, globalThis, 'self aliases globalThis');
    const selfDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'self');
    t.equal(selfDescriptor?.writable, true, 'self is writable');
    t.equal(selfDescriptor?.configurable, true, 'self is configurable');
    t.equal(typeof navigator, 'object', 'navigator is installed');
    t.equal(navigator.userAgent, 'Fino/0.1', 'navigator exposes the Fino user agent');
    t.equal(
      (
        navigator as {
          hardwareConcurrency?: unknown;
        }
      ).hardwareConcurrency,
      undefined,
      'navigator has no hardwareConcurrency shim',
    );
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    t.equal(navigatorDescriptor?.writable, true, 'navigator is writable');
    t.equal(navigatorDescriptor?.configurable, true, 'navigator is configurable');
  });
  it('does not install Node process or browser rejection-event globals', (t) => {
    t.equal(
      (
        globalThis as {
          process?: unknown;
        }
      ).process,
      undefined,
      'global process is intentionally absent',
    );
    t.equal(
      (
        globalThis as {
          onunhandledrejection?: unknown;
        }
      ).onunhandledrejection,
      undefined,
      'onunhandledrejection is not installed',
    );
    t.equal(
      (
        globalThis as {
          onrejectionhandled?: unknown;
        }
      ).onrejectionhandled,
      undefined,
      'onrejectionhandled is not installed',
    );
  });
  it('installs every public registry export on globalThis', (t) => {
    const skippedInternal = new Set(['_flushPorts']);
    const names = Object.keys(moduleRecord).filter((name) => !skippedInternal.has(name));
    names.sort();
    t.ok(names.length > 0, 'registry has public exports');
    for (const name of names) {
      t.ok(name in globalRecord, `${name} is installed on globalThis`);
      t.equal(globalRecord[name], moduleRecord[name], `${name} matches registry export`);
    }
  });
  it('installs web socket and server-sent event globals', (t) => {
    t.equal(typeof moduleRecord.WebSocket, 'function', 'registry exports WebSocket');
    t.equal(typeof moduleRecord.EventSource, 'function', 'registry exports EventSource');
    t.equal(globalRecord.WebSocket, moduleRecord.WebSocket, 'WebSocket is installed on globalThis');
    t.equal(
      globalRecord.EventSource,
      moduleRecord.EventSource,
      'EventSource is installed on globalThis',
    );
  });
  it('keeps internal helper exports off globalThis', (t) => {
    t.equal(
      typeof moduleRecord._flushPorts,
      'function',
      '_flushPorts remains importable for bootstrap',
    );
    t.equal(globalRecord._flushPorts, undefined, '_flushPorts is not installed globally');
    t.equal(
      moduleRecord.ThreadPort,
      undefined,
      'ThreadPort is not exported by the global registry',
    );
    t.equal(globalRecord.ThreadPort, undefined, 'ThreadPort is not installed globally');
    t.equal(
      moduleRecord.BaseTransportPort,
      undefined,
      'BaseTransportPort is not exported by the global registry',
    );
    t.equal(
      globalRecord.BaseTransportPort,
      undefined,
      'BaseTransportPort is not installed globally',
    );
    t.equal(
      moduleRecord.WebSocketConnection,
      undefined,
      'WebSocketConnection is not exported by the global registry',
    );
    t.equal(
      globalRecord.WebSocketConnection,
      undefined,
      'WebSocketConnection is not installed globally',
    );
    t.equal(
      moduleRecord.WebSocketError,
      undefined,
      'WebSocketError is not exported by the global registry',
    );
    t.equal(globalRecord.WebSocketError, undefined, 'WebSocketError is not installed globally');
    t.equal(
      moduleRecord.Http3WebTransportInit,
      undefined,
      'Http3WebTransportInit is not exported by the global registry',
    );
    t.equal(
      moduleRecord._fromHttp3WebTransport,
      undefined,
      '_fromHttp3WebTransport is not exported by the global registry',
    );
    t.equal(
      moduleRecord._acceptIncomingQuicWebTransportStream,
      undefined,
      '_acceptIncomingQuicWebTransportStream is not exported by the global registry',
    );
    t.equal(
      globalRecord._fromHttp3WebTransport,
      undefined,
      '_fromHttp3WebTransport is not installed globally',
    );
    t.equal(
      globalRecord._acceptIncomingQuicWebTransportStream,
      undefined,
      '_acceptIncomingQuicWebTransportStream is not installed globally',
    );
    t.equal(
      '_fromHttp3' in moduleRecord.WebTransport,
      false,
      'WebTransport does not expose internal HTTP/3 factory',
    );
    t.equal(
      '_acceptIncomingQuicStream' in moduleRecord.WebTransport.prototype,
      false,
      'WebTransport does not expose internal stream router',
    );
    t.equal(
      '_push' in moduleRecord.WebTransportDatagramDuplexStream.prototype,
      false,
      'datagram stream does not expose internal push hook',
    );
    t.equal(
      '_close' in moduleRecord.WebTransportDatagramDuplexStream.prototype,
      false,
      'datagram stream does not expose internal close hook',
    );
    t.equal(
      '_error' in moduleRecord.WebTransportDatagramDuplexStream.prototype,
      false,
      'datagram stream does not expose internal error hook',
    );
    t.equal(
      '_stats' in moduleRecord.WebTransportDatagramDuplexStream.prototype,
      false,
      'datagram stream does not expose internal stats hook',
    );
  });
  it('does not add timer/performance facade exports to the registry', (t) => {
    for (const name of [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'queueMicrotask',
      'performance',
    ]) {
      t.equal(
        moduleRecord[name],
        undefined,
        `${name} is installed by the time facade, not the global registry`,
      );
      t.ok(typeof globalRecord[name] !== 'undefined', `${name} is available on globalThis`);
    }
  });
});
