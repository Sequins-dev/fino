/**
 * Tests for boats:tls — TLS socket layer.
 *
 * These tests make real HTTPS connections to public servers. They are skipped
 * automatically when OpenSSL is not available, and may fail if the network is
 * unreachable.
 */

import { describe, it } from 'boats:test/test';
import { TlsSocket } from 'boats:net/tls';
const { tlsAvailable } = globalThis;
const skip = !tlsAvailable && 'OpenSSL (libssl) not available';
import * as loop from 'boats:runtime/loop';
const encodeUtf8 = s => new TextEncoder().encode(s);
const decodeUtf8 = b => new TextDecoder().decode(b);
import { Resolver } from 'boats:net/dns';

describe('TlsSocket', () => {
  it('connects to one.one.one.one:443', { skip }, async (t) => {
    const lp = loop.create();
    try {
      const ips = await new Resolver(lp).resolve('one.one.one.one', 'A');
      t.ok(ips.length > 0, 'DNS resolved one.one.one.one');

      const tls = await TlsSocket.connect(
        lp,
        { family: 'ipv4', ip: ips[0], port: 443 },
        { hostname: 'one.one.one.one' },
      );
      t.ok(!tls.closed, 'TlsSocket is open');

      const [reader, writer] = tls.split();
      const request = 'GET / HTTP/1.1\r\nHost: one.one.one.one\r\nConnection: close\r\n\r\n';
      await writer.write(encodeUtf8(request));

      const chunk = await reader.read();
      t.ok(chunk !== null, 'received data from server');
      t.ok(chunk.byteLength > 0, 'non-empty response');
      t.ok(decodeUtf8(chunk).includes('HTTP/'), 'response starts with HTTP/');

      reader.close();
      writer.close();
    } finally {
      loop.destroy(lp);
    }
  });

  it('TlsReader/TlsWriter pipe data correctly', { skip }, async (t) => {
    const lp = loop.create();
    try {
      const ips = await new Resolver(lp).resolve('one.one.one.one', 'A');
      const tls = await TlsSocket.connect(
        lp,
        { family: 'ipv4', ip: ips[0], port: 443 },
        { hostname: 'one.one.one.one' },
      );
      const [reader, writer] = tls.split();
      await writer.write(encodeUtf8('HEAD / HTTP/1.1\r\nHost: one.one.one.one\r\nConnection: close\r\n\r\n'));

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
    } finally {
      loop.destroy(lp);
    }
  });

  it('close() works without split', { skip }, async (t) => {
    const lp = loop.create();
    try {
      const ips = await new Resolver(lp).resolve('one.one.one.one', 'A');
      const tls = await TlsSocket.connect(
        lp,
        { family: 'ipv4', ip: ips[0], port: 443 },
        { hostname: 'one.one.one.one' },
      );
      t.ok(!tls.closed, 'open before close');
      tls.close();
      t.ok(tls.closed, 'closed after close');
      tls.close();
      t.ok(true, 'double-close is safe');
    } finally {
      loop.destroy(lp);
    }
  });

  it('rejects bad hostname (wrong cert)', { skip }, async (t) => {
    const lp = loop.create();
    try {
      let threw = false;
      try {
        await TlsSocket.connect(
          lp,
          { family: 'ipv4', ip: '1.1.1.1', port: 443 },
          { hostname: 'google.com', rejectUnauthorized: true },
        );
      } catch (_) {
        threw = true;
      }
      t.ok(threw, 'hostname mismatch causes handshake failure');
    } finally {
      loop.destroy(lp);
    }
  });

  it('rejectUnauthorized:false skips cert check', { skip }, async (t) => {
    const lp = loop.create();
    try {
      const ips = await new Resolver(lp).resolve('one.one.one.one', 'A');
      const tls = await TlsSocket.connect(
        lp,
        { family: 'ipv4', ip: ips[0], port: 443 },
        { hostname: 'one.one.one.one', rejectUnauthorized: false },
      );
      t.ok(!tls.closed, 'connected with rejectUnauthorized=false');
      tls.close();
    } finally {
      loop.destroy(lp);
    }
  });
});
