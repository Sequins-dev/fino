/**
 * Tests for `IncrementalDigest`, the streaming digest the hub client verifies
 * transfers with.
 *
 * The property that matters is that chunking is invisible: a file hashed in one
 * call, in a thousand calls, or half-replayed-then-continued must all produce the
 * same digest, because a resumed download does exactly the third of those.
 */
import { describe, it } from 'fino:test/test';
import { IncrementalDigest, cryptoAvailable, digest } from 'internal:openssl';

const encoder = new TextEncoder();
const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('IncrementalDigest', () => {
  it('agrees with the one-shot digest', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'libcrypto unavailable on this host');
      return;
    }
    for (const algorithm of ['sha-1', 'sha-256', 'sha-384', 'sha-512']) {
      const data = encoder.encode('the quick brown fox');
      using hasher = new IncrementalDigest(algorithm);
      hasher.update(data);
      t.equal(hasher.hex(), toHex(digest(algorithm, data)), `${algorithm} matches`);
    }
  });

  it('matches the published sha256 of the empty input and of "abc"', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'libcrypto unavailable on this host');
      return;
    }
    using empty = new IncrementalDigest('sha-256');
    t.equal(empty.hex(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

    using abc = new IncrementalDigest('sha-256');
    abc.update(encoder.encode('abc'));
    t.equal(abc.hex(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('is invariant to how the input is chunked', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'libcrypto unavailable on this host');
      return;
    }
    const payload = new Uint8Array(9973);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
    const expected = toHex(digest('sha-256', payload));

    for (const chunk of [1, 7, 512, 4096, payload.length]) {
      using hasher = new IncrementalDigest('sha-256');
      for (let at = 0; at < payload.length; at += chunk) {
        hasher.update(payload.subarray(at, Math.min(at + chunk, payload.length)));
      }
      t.equal(hasher.hex(), expected, `chunk size ${chunk}`);
    }
  });

  it('reproduces a digest when the first half is replayed', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'libcrypto unavailable on this host');
      return;
    }
    const payload = encoder.encode('x'.repeat(5000) + 'y'.repeat(5000));
    const expected = toHex(digest('sha-256', payload));
    // The shape a resumed transfer takes: replay what is already on disk, then
    // continue with what arrives over the wire.
    using hasher = new IncrementalDigest('sha-256');
    hasher.update(payload.subarray(0, 5000));
    hasher.update(payload.subarray(5000));
    t.equal(hasher.hex(), expected);
  });

  it('ignores empty chunks', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'libcrypto unavailable on this host');
      return;
    }
    using hasher = new IncrementalDigest('sha-256');
    hasher.update(new Uint8Array(0));
    hasher.update(encoder.encode('abc'));
    hasher.update(new Uint8Array(0));
    t.equal(hasher.hex(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('refuses to be reused after finalizing', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'libcrypto unavailable on this host');
      return;
    }
    const hasher = new IncrementalDigest('sha-256');
    hasher.update(encoder.encode('abc'));
    hasher.final();
    t.throws(() => hasher.update(encoder.encode('more')), /already finalized/);
    t.throws(() => hasher.final(), /already finalized/);
    // Releasing twice is harmless, so `using` after an explicit close is safe.
    hasher.close();
    hasher.close();
    t.ok(true, 'close is idempotent');
  });

  it('reports the digest length and rejects unknown algorithms', async (t) => {
    if (!cryptoAvailable) {
      t.ok(true, 'libcrypto unavailable on this host');
      return;
    }
    using hasher = new IncrementalDigest('sha-256');
    t.equal(hasher.size, 32);
    t.equal(hasher.final().byteLength, 32);
    t.throws(() => new IncrementalDigest('md5'), /Unsupported digest algorithm/);
  });
});
