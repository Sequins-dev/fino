import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
const decodeUtf8 = (value: Uint8Array) => new TextDecoder().decode(value);
describe('internal OpenSSL loader', () => {
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
