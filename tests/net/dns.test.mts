/**
 * Tests for boats:dns — Resolver, lookup, wire protocol helpers.
 */

import { describe, it, before, after } from 'boats:test/test';
import {
  Resolver, lookup, RECORD_TYPES,
  _encodeName, _buildQuery, _decodeName, _parseResponse, _reverseIP,
} from 'boats:net/dns';
import * as loop from 'boats:runtime/loop';

describe('Wire protocol', () => {
  it('_encodeName — multi-label', (t) => {
    const out = _encodeName('example.com');
    t.equal(out[0], 7, 'first label length = 7');
    t.equal(out[8], 3, 'second label length = 3');
    t.equal(out[12], 0, 'root label');
    t.equal(out.length, 13, 'total length');
  });

  it('_encodeName — single label', (t) => {
    const out = _encodeName('localhost');
    t.equal(out[0], 9, 'label length = 9');
    t.equal(out[10], 0, 'root label');
    t.equal(out.length, 11, 'total length');
  });

  it('_encodeName — strips trailing dot', (t) => {
    const a = _encodeName('example.com');
    const b = _encodeName('example.com.');
    t.equal(a.length, b.length, 'same length with/without trailing dot');
    for (let i = 0; i < a.length; i++) {
      t.equal(a[i], b[i], `byte ${i} matches`);
    }
  });

  it('_buildQuery — header fields', (t) => {
    const pkt  = _buildQuery(0x1234, 'example.com', RECORD_TYPES.A);
    const view = new DataView(pkt.buffer);
    t.equal(view.getUint16(0, false), 0x1234, 'ID');
    t.equal(view.getUint16(2, false), 0x0100, 'flags (RD=1)');
    t.equal(view.getUint16(4, false), 1,      'QDCOUNT = 1');
    t.equal(view.getUint16(6, false), 0,      'ANCOUNT = 0');
    t.equal(view.getUint16(8, false), 0,      'NSCOUNT = 0');
    t.equal(view.getUint16(10, false), 0,     'ARCOUNT = 0');
  });

  it('_buildQuery — question section QTYPE and QCLASS', (t) => {
    const pkt       = _buildQuery(1, 'example.com', RECORD_TYPES.A);
    const nameBytes = _encodeName('example.com');
    const view      = new DataView(pkt.buffer);
    const qtypeOff  = 12 + nameBytes.length;
    t.equal(view.getUint16(qtypeOff,     false), RECORD_TYPES.A, 'QTYPE = A');
    t.equal(view.getUint16(qtypeOff + 2, false), 1,              'QCLASS = IN');
  });

  it('_decodeName — simple name (no compression)', (t) => {
    const encoded = _encodeName('foo.bar');
    const { name, nextOffset } = _decodeName(encoded, 0);
    t.equal(name, 'foo.bar', 'decoded name');
    t.equal(nextOffset, encoded.length, 'nextOffset at end');
  });

  it('_decodeName — compression pointer', (t) => {
    const encoded = _encodeName('example.com');
    const msg     = new Uint8Array(12 + encoded.length + 2);
    msg.set(encoded, 12);
    msg[12 + encoded.length]     = 0xC0;
    msg[12 + encoded.length + 1] = 0x0C;
    const { name } = _decodeName(msg, 12 + encoded.length);
    t.equal(name, 'example.com', 'pointer resolves to correct name');
  });

  it('_parseResponse — synthetic A record response', (t) => {
    const qname    = _encodeName('example.com');
    const totalLen = 12 + qname.length + 4 +
                     qname.length + 4 + 2 + 4 + 2 + 4;
    const msg  = new Uint8Array(totalLen);
    const view = new DataView(msg.buffer);
    view.setUint16(0,  0xABCD, false);
    view.setUint16(2,  0x8180, false);
    view.setUint16(4,  1,      false);
    view.setUint16(6,  1,      false);
    let off = 12;
    msg.set(qname, off); off += qname.length;
    view.setUint16(off, RECORD_TYPES.A, false); off += 2;
    view.setUint16(off, 1, false); off += 2;
    msg.set(qname, off); off += qname.length;
    view.setUint16(off, RECORD_TYPES.A, false); off += 2;
    view.setUint16(off, 1,              false); off += 2;
    view.setUint32(off, 300,            false); off += 4;
    view.setUint16(off, 4,              false); off += 2;
    msg[off] = 93; msg[off + 1] = 184; msg[off + 2] = 216; msg[off + 3] = 34;
    const parsed = _parseResponse(msg);
    t.equal(parsed.id, 0xABCD, 'ID matches');
    t.equal(parsed.rcode, 0, 'RCODE = 0');
    t.equal(parsed.answers.length, 1, 'one answer');
    t.equal(parsed.answers[0].data, '93.184.216.34', 'A record data');
    t.equal(parsed.answers[0].ttl,  300, 'TTL');
  });

  it('_reverseIP — IPv4', (t) => {
    t.equal(_reverseIP('1.2.3.4'), '4.3.2.1.in-addr.arpa', 'IPv4 reverse');
    t.equal(_reverseIP('8.8.8.8'), '8.8.8.8.in-addr.arpa', 'Google DNS reverse name');
  });

  it('_reverseIP — IPv6', (t) => {
    const result = _reverseIP('2001:db8::1');
    t.ok(result.endsWith('.ip6.arpa'), 'ends with .ip6.arpa');
    t.ok(result.startsWith('1.'), 'first nibble is trailing 1');
  });
});

describe('Integration', () => {
  let lp;
  before(() => { lp = loop.create(); });
  after(() => { loop.destroy(lp); });

  it('resolver.resolve4 — example.com', async (t) => {
    const addrs = await new Resolver(lp).resolve4('example.com');
    t.ok(Array.isArray(addrs) && addrs.length > 0, 'got at least one A record');
    t.ok(addrs.every(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)), 'all are IPv4 strings');
  });

  it('resolver.resolve6 — example.com', async (t) => {
    const addrs = await new Resolver(lp).resolve6('example.com');
    t.ok(Array.isArray(addrs) && addrs.length > 0, 'got at least one AAAA record');
    t.ok(addrs.every(a => a.includes(':')), 'all contain colons (IPv6)');
  });

  it('resolver.resolveMx — example.com', async (t) => {
    const records = await new Resolver(lp).resolveMx('example.com');
    t.ok(Array.isArray(records) && records.length > 0, 'got MX records');
    t.ok(typeof records[0].exchange === 'string', 'has exchange field');
    t.ok(typeof records[0].priority === 'number', 'has priority field');
  });

  it('resolver.resolveNs — example.com', async (t) => {
    const ns = await new Resolver(lp).resolveNs('example.com');
    t.ok(Array.isArray(ns) && ns.length > 0, 'got NS records');
    t.ok(ns.every(n => typeof n === 'string' && n.includes('.')), 'all are domain strings');
  });

  it('resolver.resolveTxt — example.com', async (t) => {
    const txt = await new Resolver(lp).resolveTxt('example.com');
    t.ok(Array.isArray(txt), 'TXT result is an array');
    for (const entry of txt) {
      t.ok(Array.isArray(entry), 'each TXT entry is an array of strings');
    }
  });

  it('resolver — NXDOMAIN throws', async (t) => {
    await t.rejects(
      () => new Resolver(lp).resolve4('this-domain-definitely-does-not-exist-xyzzy123456.com'),
      (err) => /NXDOMAIN|not found|ENOTFOUND/i.test(err.message + ' ' + (err.code ?? '')),
      'NXDOMAIN throws with expected message/code',
    );
  });

  it('resolver.setServers — overrides servers and resolves', async (t) => {
    const resolver = new Resolver(lp);
    resolver.setServers(['1.1.1.1']);
    t.deepEqual(resolver.getServers(), ['1.1.1.1'], 'getServers returns overridden servers');
    const addrs = await resolver.resolve4('example.com');
    t.ok(Array.isArray(addrs) && addrs.length > 0, 'still resolves with custom server');
  });

  it('resolver.reverse — 8.8.8.8', async (t) => {
    const resolver = new Resolver(lp);
    resolver.setServers(['8.8.8.8']);
    const names = await resolver.reverse('8.8.8.8');
    t.ok(Array.isArray(names) && names.length > 0, 'got PTR records');
    t.ok(names.some(n => /google|dns/i.test(n)),
      'PTR for 8.8.8.8 includes "google" or "dns": ' + JSON.stringify(names));
  });

  it('lookup — example.com family 4', async (t) => {
    const result = await lookup(lp, 'example.com');
    t.ok(typeof result.address === 'string', 'has address');
    t.equal(result.family, 4, 'family = 4');
    t.ok(/^\d+\.\d+\.\d+\.\d+$/.test(result.address), 'address is IPv4');
  });

  it('lookup — example.com family 6', async (t) => {
    const result = await lookup(lp, 'example.com', { family: 6 });
    t.ok(typeof result.address === 'string', 'has address');
    t.equal(result.family, 6, 'family = 6');
    t.ok(result.address.includes(':'), 'address is IPv6');
  });

  it('resolver — timeout with unreachable server', async (t) => {
    const resolver = new Resolver(lp, { timeout: 500, retries: 1 });
    resolver.setServers(['192.0.2.1']);
    await t.rejects(
      () => resolver.resolve4('example.com'),
      (err) => /timeout|ETIMEOUT/i.test(err.message + ' ' + (err.code ?? '')),
      'throws timeout error for unreachable server',
    );
  });
});
