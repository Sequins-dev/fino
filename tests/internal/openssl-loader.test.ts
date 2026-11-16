import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
const decodeUtf8 = (value: Uint8Array) => new TextDecoder().decode(value);
const adapterSpecifier = 'internal:net/quic/ngtcp2/crypto-ossl';
const nativeAdapter = (await import(
  adapterSpecifier
)) as typeof import('../../js/internal/net/quic/ngtcp2/crypto-ossl.ts');
async function withNativeFixture(
  sourcePath: string,
  mock: string,
  visit: (module: any) => void,
  patch: (source: string) => string = (source) => source,
): Promise<void> {
  const fs = new DiskFileSystem();
  const dir = `/tmp/fino-openssl-loader-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.mkdir(dir);
  try {
    const source = patch(decodeUtf8(await fs.readFile(sourcePath)))
      .replace("from 'fino:ffi'", `from '${dir}/ffi.ts'`)
      .replace("from './encoding.ts'", "from 'internal:encoding'")
      .replace("from '../../../openssl.ts'", "from 'internal:openssl'");
    await fs.writeFile(`${dir}/ffi.ts`, new TextEncoder().encode(mock));
    await fs.writeFile(`${dir}/native.ts`, new TextEncoder().encode(source));
    visit(await import(`${dir}/native.ts`));
  } finally {
    await fs.unlink(`${dir}/native.ts`).catch(() => {});
    await fs.unlink(`${dir}/ffi.ts`).catch(() => {});
    await fs.rmdir(dir);
  }
}

const mockHeader = `
export { Pointer, FfiCallback } from 'fino:ffi';
function address(value) {
  const bytes = new ArrayBuffer(8);
  new DataView(bytes).setBigUint64(0, value, true);
  return bytes;
}
`;
const fixturePaths = (source: string) =>
  source.replace(
    /const _cryptoPaths:[\s\S]*?;\nconst _sslPaths:[\s\S]*?;\n/,
    `
const _cryptoPaths = ['crypto-a'];
const _sslPaths = ['ssl-a', 'ssl-b'];
`,
  );

describe('internal OpenSSL loader', () => {
  it('rejects an adapter from a different OpenSSL instance before exposing native calls', async (t) => {
    await withNativeFixture(
      'js/internal/net/quic/ngtcp2/crypto-ossl.ts',
      mockHeader +
        `
export function dlopen() {
  return { symbols: {}, pointers: { SSL_new: address(0n), EVP_PKEY_free: address(0n) } };
}
`,
      (module) => {
        t.equal(module.cryptoOsslAvailable, false);
        t.equal(module.sym, null);
        t.equal(module.ptr, null);
        t.throws(() => module.requireCryptoOssl(), /incompatible OpenSSL/i);
      },
    );
  });

  it(
    'accepts matching native identities and rejects either mismatched identity',
    {
      skip: !nativeAdapter.cryptoOsslAvailable,
    },
    async (t) => {
      const openssl = await import('internal:openssl');
      const pointers = nativeAdapter.requireCryptoOssl().pointers;
      t.equal(openssl.isOpenSslLibraryCompatible(pointers), true);
      t.equal(
        openssl.isOpenSslLibraryCompatible({ ...pointers, SSL_new: new ArrayBuffer(8) }),
        false,
      );
      t.equal(
        openssl.isOpenSslLibraryCompatible({ ...pointers, EVP_PKEY_free: new ArrayBuffer(8) }),
        false,
      );
    },
  );

  it(
    'rejects a backend missing the native QUIC TLS integration API',
    {
      skip: !nativeAdapter.cryptoOsslAvailable,
    },
    async (t) => {
      await withNativeFixture(
        'js/internal/net/quic/ngtcp2/crypto-ossl.ts',
        mockHeader +
          `
import { dlopen as realOpen } from 'fino:ffi';
export function dlopen(path, definitions) {
  if ('SSL_set_quic_tls_cbs' in definitions) throw Error('missing QUIC TLS integration API');
  return realOpen(path, definitions);
}
`,
        (module) => {
          t.equal(module.cryptoOsslAvailable, false);
          t.throws(() => module.requireCryptoOssl(), /not found/);
        },
      );
    },
  );

  it('selects TLS and crypto as one complete provider', async (t) => {
    await withNativeFixture(
      'js/internal/openssl.ts',
      mockHeader +
        `
export function dlopen(path, definitions) {
  if (path === 'ssl-a' && 'RAND_bytes' in definitions) throw Error('incomplete crypto API');
  const value = path === 'ssl-b' ? 2n : 1n;
  return {
    symbols: { TLS_client_method: () => address(value), SSL_CTX_new: () => address(value) },
    pointers: { SSL_new: address(value), SSL_CTX_new: address(value), EVP_PKEY_free: address(value) },
  };
}
`,
      (module) => {
        t.equal(module.cryptoAvailable, true);
        t.equal(module.tlsAvailable, true);
        t.equal(new DataView(module.sslCtxNewClient()).getBigUint64(0, true), 2n);
      },
      fixturePaths,
    );
  });

  it('does not borrow QUIC symbols from another TLS library candidate', async (t) => {
    await withNativeFixture(
      'js/internal/openssl.ts',
      mockHeader +
        `
export function dlopen(path, definitions) {
  if (path === 'ssl-a' && 'OSSL_QUIC_client_thread_method' in definitions) throw Error('no QUIC');
  return {
    symbols: { OSSL_QUIC_client_thread_method: () => address(1n), SSL_CTX_new: () => address(2n) },
    pointers: { SSL_new: address(path === 'ssl-b' ? 3n : 1n), SSL_CTX_new: address(path === 'ssl-b' ? 3n : 1n), EVP_PKEY_free: address(2n) },
  };
}
`,
      (module) => {
        t.equal(module.cryptoAvailable, true);
        t.equal(module.tlsAvailable, true);
        t.throws(() => module.sslCtxNewQuicClient(), /OpenSSL QUIC SSL not available/);
      },
      fixturePaths,
    );
  });

  it('keeps crypto-only installations available when TLS cannot load', async (t) => {
    await withNativeFixture(
      'js/internal/openssl.ts',
      mockHeader +
        `
export function dlopen(path) {
  if (path !== 'crypto-a') throw Error('no TLS');
  return { symbols: {}, pointers: {} };
}
`,
      (module) => {
        t.equal(module.cryptoAvailable, true);
        t.equal(module.tlsAvailable, false);
      },
      fixturePaths,
    );
  });

  it('searches versioned libraries in keg-only Homebrew OpenSSL installations', async (t) => {
    const source = decodeUtf8(await new DiskFileSystem().readFile('js/internal/openssl.ts'));
    for (const prefix of ['/opt/homebrew', '/usr/local']) {
      for (const library of ['crypto', 'ssl']) {
        t.ok(
          source.includes(`'${prefix}/opt/openssl@3/lib/lib${library}.3.dylib'`),
          `finds ${library} in the ${prefix} OpenSSL keg without brew link`,
        );
      }
    }
  });
  it('does not use unversioned macOS OpenSSL dylib candidates', async (t) => {
    const fs = new DiskFileSystem();
    const source = decodeUtf8(await fs.readFile('js/internal/openssl.ts'));
    t.equal(
      source.includes("'/opt/homebrew/lib/libcrypto.dylib'"),
      false,
      'omits Homebrew unversioned libcrypto',
    );
    t.equal(
      source.includes("'/usr/local/lib/libcrypto.dylib'"),
      false,
      'omits Intel Homebrew unversioned libcrypto',
    );
    t.equal(
      source.includes("'/opt/homebrew/lib/libssl.dylib'"),
      false,
      'omits Homebrew unversioned libssl',
    );
    t.equal(
      source.includes("'/usr/local/lib/libssl.dylib'"),
      false,
      'omits Intel Homebrew unversioned libssl',
    );
  });
});
