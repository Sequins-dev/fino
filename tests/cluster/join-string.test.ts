/**
 * Tests for internal:cluster/join-string — mint/parse round trip.
 */
import { describe, it } from 'fino:test/test';
import { mintJoinString, parseJoinString } from 'internal:cluster/join-string';

const HASH = 'ab'.repeat(32);

describe('cluster join strings', () => {
  it('round-trips seed, identity, token, and pinned hashes', (t) => {
    const minted = mintJoinString({
      seed: 'https://10.0.0.5:4433/__fino_cluster',
      clusterId: 'c-x7f2',
      token: '9hj3k2m4n5p6',
      certHashes: [HASH],
    });
    t.ok(minted.startsWith('fino://10.0.0.5:4433/__fino_cluster#'), 'uses the fino scheme');
    const parsed = parseJoinString(minted);
    t.equal(parsed.seed, 'https://10.0.0.5:4433/__fino_cluster', 'seed endpoint survives');
    t.equal(parsed.clusterId, 'c-x7f2', 'cluster id survives');
    t.equal(parsed.token, '9hj3k2m4n5p6', 'token survives');
    t.deepEqual(parsed.certHashes, [HASH], 'certificate hash survives');
  });
  it('ignores unknown fragment keys for forward compatibility', (t) => {
    const parsed = parseJoinString(`fino://h:1/p#cid:c1,tok:t1,future:zzz,sha256:${HASH}`);
    t.equal(parsed.clusterId, 'c1');
    t.equal(parsed.certHashes.length, 1);
  });
  it('rejects malformed join strings', (t) => {
    t.throws(() => parseJoinString('not a url'), /not a URL/, 'garbage rejected');
    t.throws(() => parseJoinString('https://h:1/p#cid:c,tok:t'), /fino:/, 'wrong scheme rejected');
    t.throws(() => parseJoinString('fino://h:1/p#tok:t'), /missing cid/, 'cid required');
    t.equal(
      parseJoinString('fino://h:1/p#cid:c').token,
      undefined,
      'token is optional (unauthenticated clusters)',
    );
    t.throws(
      () => parseJoinString('fino://h:1/p#cid:c,tok:t,sha256:xyz'),
      /64 hex/,
      'short hash rejected',
    );
  });
});
