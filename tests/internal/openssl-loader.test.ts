import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
describe('internal OpenSSL loader', () => {
  it('does not use unversioned macOS OpenSSL dylib candidates', async (t) => {
    const fs = new DiskFileSystem();
    const source = await fs.readFile('js/internal/openssl.ts', 'utf8');
    t.equal(source.includes('\'/opt/homebrew/lib/libcrypto.dylib\''), false, 'omits Homebrew unversioned libcrypto');
    t.equal(source.includes('\'/usr/local/lib/libcrypto.dylib\''), false, 'omits Intel Homebrew unversioned libcrypto');
    t.equal(source.includes('\'/opt/homebrew/lib/libssl.dylib\''), false, 'omits Homebrew unversioned libssl');
    t.equal(source.includes('\'/usr/local/lib/libssl.dylib\''), false, 'omits Intel Homebrew unversioned libssl');
  });
});
