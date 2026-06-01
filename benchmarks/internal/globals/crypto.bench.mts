/**
 * Benchmarks for fino:crypto
 *
 * Run with: cargo run -- --bench benchmarks/crypto.bench.mts
 *
 * Notes:
 * - The bench framework's setup() is synchronous, but key import/generation is
 *   async. For sign/verify/encrypt/decrypt benchmarks we include the key import
 *   cost in the measured fn (it's realistic overhead anyway).
 * - Raw key bytes are generated once at module level using getRandomValues() (sync).
 */

import { crypto } from 'fino:crypto';
import { bench } from 'fino:bench';

// Pre-generate raw key material synchronously — used in async import inside fn
const HMAC_KEY_BYTES = new Uint8Array(32);
crypto.getRandomValues(HMAC_KEY_BYTES);

const AES_KEY_BYTES = new Uint8Array(32); // 256-bit AES key
crypto.getRandomValues(AES_KEY_BYTES);

const IV = new Uint8Array(12);
crypto.getRandomValues(IV);

const DATA_64    = new Uint8Array(64);
const DATA_1KB   = new Uint8Array(1024);
const DATA_64KB  = new Uint8Array(65536);

bench('random', (b) => {
  const buf16  = new Uint8Array(16);
  const buf64  = new Uint8Array(64);
  const buf256 = new Uint8Array(256);

  b.group('getRandomValues by size', (g) => {
    g.measure('16 bytes',  () => crypto.getRandomValues(buf16));
    g.measure('64 bytes',  () => crypto.getRandomValues(buf64));
    g.measure('256 bytes', () => crypto.getRandomValues(buf256));
  });

  b.measure('randomUUID', () => crypto.randomUUID());
});

bench('digest', (b) => {
  b.group('SHA-256 by size', (g) => {
    g.measure('64 bytes',  async () => await crypto.subtle.digest('SHA-256', DATA_64));
    g.measure('1KB',       async () => await crypto.subtle.digest('SHA-256', DATA_1KB));
    g.measure('64KB',      async () => await crypto.subtle.digest('SHA-256', DATA_64KB));
  });

  b.group('algorithm comparison (1KB)', (g) => {
    g.measure('SHA-1',   async () => await crypto.subtle.digest('SHA-1', DATA_1KB));
    g.measure('SHA-256', async () => await crypto.subtle.digest('SHA-256', DATA_1KB));
    g.measure('SHA-384', async () => await crypto.subtle.digest('SHA-384', DATA_1KB));
    g.measure('SHA-512', async () => await crypto.subtle.digest('SHA-512', DATA_1KB));
  });
});

bench('HMAC', (b) => {
  b.measure('sign 1KB', {
    fn: async () => {
      const key = await crypto.subtle.importKey('raw', HMAC_KEY_BYTES, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return await crypto.subtle.sign('HMAC', key, DATA_1KB);
    },
  });

  b.measure('verify 1KB', {
    fn: async () => {
      const key = await crypto.subtle.importKey('raw', HMAC_KEY_BYTES, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
      const sig = await crypto.subtle.sign('HMAC', key, DATA_1KB);
      return await crypto.subtle.verify('HMAC', key, sig, DATA_1KB);
    },
  });

  b.group('importKey', (g) => {
    g.measure('HMAC-SHA256', async () => await crypto.subtle.importKey('raw', HMAC_KEY_BYTES, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
    g.measure('HMAC-SHA512', async () => await crypto.subtle.importKey('raw', HMAC_KEY_BYTES, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']));
  });
});

bench('AES-GCM', (b) => {
  b.group('encrypt by size', (g) => {
    g.measure('64 bytes', {
      fn: async () => {
        const key = await crypto.subtle.importKey('raw', AES_KEY_BYTES, { name: 'AES-GCM' }, false, ['encrypt']);
        return await crypto.subtle.encrypt({ name: 'AES-GCM', iv: IV }, key, DATA_64);
      },
    });
    g.measure('1KB', {
      fn: async () => {
        const key = await crypto.subtle.importKey('raw', AES_KEY_BYTES, { name: 'AES-GCM' }, false, ['encrypt']);
        return await crypto.subtle.encrypt({ name: 'AES-GCM', iv: IV }, key, DATA_1KB);
      },
    });
    g.measure('64KB', {
      fn: async () => {
        const key = await crypto.subtle.importKey('raw', AES_KEY_BYTES, { name: 'AES-GCM' }, false, ['encrypt']);
        return await crypto.subtle.encrypt({ name: 'AES-GCM', iv: IV }, key, DATA_64KB);
      },
    });
  });

  b.measure('decrypt 1KB', {
    fn: async () => {
      const key = await crypto.subtle.importKey('raw', AES_KEY_BYTES, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      const ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: IV }, key, DATA_1KB);
      return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: IV }, key, ct);
    },
  });
});

bench('key management', (b) => {
  b.measure('generateKey HMAC-SHA256', async () => await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  b.measure('generateKey AES-GCM-256', async () => await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  b.measure('importKey raw AES-GCM',   async () => await crypto.subtle.importKey('raw', AES_KEY_BYTES, { name: 'AES-GCM' }, false, ['encrypt']));
});
