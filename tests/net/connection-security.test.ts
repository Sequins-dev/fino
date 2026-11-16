/** Connection policy identity contracts shared by HTTP transport pools. */
import { describe, it } from 'fino:test/test';
import { connectionSecurityKey } from 'internal:net/http/pool';

describe('HTTP connection security identity', () => {
  it('compares effective values independent of property order and copies byte roots', (t) => {
    t.equal(
      connectionSecurityKey({
        verifyPeer: true,
        ca: { file: 'ca.pem', pem: new Uint8Array([1, 2]) },
      }),
      connectionSecurityKey({
        ca: { pem: new Uint8Array([1, 2]), file: 'ca.pem' },
        verifyPeer: true,
        key: undefined,
      }),
    );
  });
  it('isolates every supported QUIC connection option', (t) => {
    const baseline = { verifyPeer: true, serverName: 'localhost' };
    const changes = {
      verifyPeer: false,
      serverName: 'other.test',
      ca: { file: 'ca.pem', directory: 'roots', pem: new Uint8Array([1]) },
      certificateFile: 'client.pem',
      privateKeyFile: 'client.key',
      versions: ['v1'],
      tlsCipherSuites: ['TLS_AES_128_GCM_SHA256'],
      tlsGroups: ['X25519'],
      retry: { enabled: true },
      sessionStore: {},
      earlyData: { replaySafe: true },
      migration: { enabled: true },
      datagrams: { enabled: true },
      connection: { handshakeTimeoutMs: 100, maxData: 1024n },
      transport: { ecn: true },
      qlog: { path: 'trace' },
      keylog: { path: 'keys' },
    };
    for (const [field, value] of Object.entries(changes)) {
      t.notEqual(
        connectionSecurityKey({ ...baseline, [field]: value }),
        connectionSecurityKey(baseline),
        field,
      );
    }
    t.notEqual(
      connectionSecurityKey({ ca: { pem: new Uint8Array([1]) } }),
      connectionSecurityKey({ ca: { pem: new Uint8Array([2]) } }),
    );
  });
  it('keeps stateful session stores isolated by identity', (t) => {
    const store = {};
    t.equal(
      connectionSecurityKey({ sessionStore: store }),
      connectionSecurityKey({ sessionStore: store }),
    );
    t.notEqual(
      connectionSecurityKey({ sessionStore: store }),
      connectionSecurityKey({ sessionStore: {} }),
    );
  });
});
