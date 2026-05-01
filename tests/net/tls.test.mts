/**
 * Tests for fino:tls — TLS socket layer.
 *
 * These tests make real HTTPS connections to public servers. They are skipped
 * automatically when OpenSSL is not available, and may fail if the network is
 * unreachable.
 */

import { describe, it } from 'fino:test/test';
import { TlsSocket } from 'fino:net/tls';
const tlsAvailable = (globalThis as typeof globalThis & { tlsAvailable?: boolean }).tlsAvailable;
const skip = !tlsAvailable && 'OpenSSL (libssl) not available';
const encodeUtf8 = (s: string) => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView) => new TextDecoder().decode(b);
import { Resolver } from 'fino:net/dns';

describe('TlsSocket', () => {
  it('connects to one.one.one.one:443', { skip }, async (t) => {
    const ips = await new Resolver().resolve('one.one.one.one', 'A');
    t.ok(ips.length > 0, 'DNS resolved one.one.one.one');
    const ip = ips[0];
    if (typeof ip !== 'string') throw new Error('expected IPv4 string');

    const tls = await TlsSocket.connect(
      { family: 'ipv4', ip, port: 443 },
      { hostname: 'one.one.one.one' },
    );
    t.ok(!tls.closed, 'TlsSocket is open');

    const [reader, writer] = tls.split();
    const request = 'GET / HTTP/1.1\r\nHost: one.one.one.one\r\nConnection: close\r\n\r\n';
    await writer.write(encodeUtf8(request));
    await writer.flush();

    const chunk = await reader.read();
    t.ok(chunk !== null, 'received data from server');
    if (chunk === null) throw new Error('expected chunk');
    t.ok(chunk.byteLength > 0, 'non-empty response');
    t.ok(decodeUtf8(chunk).includes('HTTP/'), 'response starts with HTTP/');

    reader.close();
    writer.close();
  });

  it('TlsReader/TlsWriter pipe data correctly', { skip }, async (t) => {
    const ips = await new Resolver().resolve('one.one.one.one', 'A');
    const ip = ips[0];
    if (typeof ip !== 'string') throw new Error('expected IPv4 string');
    const tls = await TlsSocket.connect(
      { family: 'ipv4', ip, port: 443 },
      { hostname: 'one.one.one.one' },
    );
    const [reader, writer] = tls.split();
    await writer.write(encodeUtf8('HEAD / HTTP/1.1\r\nHost: one.one.one.one\r\nConnection: close\r\n\r\n'));
    await writer.flush();

    let response = '';
    let chunk;
    while ((chunk = await reader.read()) !== null) {
      response += decodeUtf8(chunk);
      if (response.includes('\r\n\r\n')) break;
    }
    t.ok(response.includes('HTTP/'), 'got HTTP response');
    t.ok(response.includes('\r\n'), 'response has CRLF headers');

    reader.close();
    writer.close();
  });

  it('close() works without split', { skip }, async (t) => {
    const ips = await new Resolver().resolve('one.one.one.one', 'A');
    const ip = ips[0];
    if (typeof ip !== 'string') throw new Error('expected IPv4 string');
    const tls = await TlsSocket.connect(
      { family: 'ipv4', ip, port: 443 },
      { hostname: 'one.one.one.one' },
    );
    t.ok(!tls.closed, 'open before close');
    tls.close();
    t.ok(tls.closed, 'closed after close');
    tls.close();
    t.ok(true, 'double-close is safe');
  });

  it('rejects bad hostname (wrong cert)', { skip }, async (t) => {
    let threw = false;
    try {
      await TlsSocket.connect(
        { family: 'ipv4', ip: '1.1.1.1', port: 443 },
        { hostname: 'google.com', rejectUnauthorized: true },
      );
    } catch (_) {
      threw = true;
    }
    t.ok(threw, 'hostname mismatch causes handshake failure');
  });

  it('rejectUnauthorized:false skips cert check', { skip }, async (t) => {
    const ips = await new Resolver().resolve('one.one.one.one', 'A');
    const ip = ips[0];
    if (typeof ip !== 'string') throw new Error('expected IPv4 string');
    const tls = await TlsSocket.connect(
      { family: 'ipv4', ip, port: 443 },
      { hostname: 'one.one.one.one', rejectUnauthorized: false },
    );
    t.ok(!tls.closed, 'connected with rejectUnauthorized=false');
    tls.close();
  });

  it('rejectUnauthorized:false succeeds even with wrong hostname (proves bypass works)', { skip }, async (t) => {
    // Connects to 1.1.1.1 but claims it's google.com — cert mismatch.
    // With rejectUnauthorized:true this fails (tested above).
    // With rejectUnauthorized:false it MUST succeed, proving the flag
    // actually bypasses verification rather than just being a no-op when
    // the cert is valid anyway.
    let threw = false;
    let tls;
    try {
      tls = await TlsSocket.connect(
        { family: 'ipv4', ip: '1.1.1.1', port: 443 },
        { hostname: 'google.com', rejectUnauthorized: false },
      );
    } catch (_) {
      threw = true;
    }
    t.ok(!threw, 'rejectUnauthorized:false bypasses hostname mismatch');
    if (tls) tls.close();
  });
});
