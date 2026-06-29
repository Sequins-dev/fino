import { describe, it } from 'fino:test/test';
import { WPT_MANIFEST } from './fixtures/wpt/manifest.generated.ts';
const entryByPath = new Map(WPT_MANIFEST.entries.map((entry) => [entry.path, entry]));
describe('WPT generated manifest', () => {
  it('marks compression media fetch tests runnable through local WPT resources', (t) => {
    for (const path of ['compression/compression-output-length.any.js', 'compression/compression-stream.any.js']) {
      const entry = entryByPath.get(path);
      t.ok(entry !== undefined, `${path} exists in manifest`);
      t.equal(entry?.runnable, true, `${path} is runnable`);
      t.equal(entry?.reason, null, `${path} has no skip reason`);
    }
  });
  it('separates URLPattern local fixture coverage from tentative API debt', (t) => {
    for (const [path, reason] of [['urlpattern/urlpattern.any.js', 'requires URLPattern tokenizer, canonicalization, and full data-driven conformance'], ['urlpattern/urlpattern.https.any.js', 'requires URLPattern tokenizer, canonicalization, and full data-driven conformance']] as const) {
      const entry = entryByPath.get(path);
      t.ok(entry !== undefined, `${path} exists in manifest`);
      t.equal(entry?.runnable, false, `${path} is skipped`);
      t.equal(entry?.reason, reason, `${path} has conformance-debt reason`);
    }
    const generate = entryByPath.get('urlpattern/urlpattern-generate.tentative.any.js');
    t.ok(generate !== undefined, 'URLPattern generate WPT exists in manifest');
    t.equal(generate?.runnable, true, 'URLPattern generate WPT is runnable');
    t.equal(generate?.reason, null, 'URLPattern generate WPT has no skip reason');
    for (const path of ['urlpattern/urlpattern-compare.tentative.any.js', 'urlpattern/urlpattern-compare.tentative.https.any.js']) {
      const entry = entryByPath.get(path);
      t.ok(entry !== undefined, `${path} exists in manifest`);
      t.equal(entry?.runnable, true, `${path} is runnable`);
      t.equal(entry?.reason, null, `${path} has no skip reason`);
    }
  });
  it('separates URL local fixture loading from parser conformance debt', (t) => {
    for (const [path, reason] of [
      ['url/url-constructor.any.js', 'requires WHATWG URL parser conformance for data-driven constructor cases'],
      ['url/url-origin.any.js', 'requires WHATWG URL origin serialization conformance'],
      ['url/url-setters.any.js', 'requires WHATWG URL setter conformance for data-driven setter cases']
    ] as const) {
      const entry = entryByPath.get(path);
      t.ok(entry !== undefined, `${path} exists in manifest`);
      t.equal(entry?.runnable, false, `${path} is skipped`);
      t.equal(entry?.reason, reason, `${path} has conformance-debt reason`);
    }
  });
  it('keeps WebCrypto runnable files within the current release subset', (t) => {
    for (const path of [
      'WebCryptoAPI/digest/digest.https.any.js',
      'WebCryptoAPI/getRandomValues.any.js',
      'WebCryptoAPI/randomUUID.https.any.js',
      'WebCryptoAPI/serialization/aes-gcm.https.any.js'
    ]) {
      const entry = entryByPath.get(path);
      t.ok(entry !== undefined, `${path} exists in manifest`);
      t.equal(entry?.runnable, true, `${path} is runnable`);
      t.equal(entry?.reason, null, `${path} has no skip reason`);
    }
    for (const path of [
      'WebCryptoAPI/derive_bits_keys/hkdf.https.any.js',
      'WebCryptoAPI/encrypt_decrypt/aes_gcm.https.any.js',
      'WebCryptoAPI/generateKey/successes_RSA-OAEP.https.any.js',
      'WebCryptoAPI/idlharness.https.any.js',
      'WebCryptoAPI/wrapKey_unwrapKey/wrapKey_unwrapKey.https.any.js'
    ]) {
      const entry = entryByPath.get(path);
      t.ok(entry !== undefined, `${path} exists in manifest`);
      t.equal(entry?.runnable, false, `${path} is skipped`);
      t.equal(entry?.reason, 'requires broader WebCrypto algorithm and key-format WPT parity beyond the current release subset', `${path} has conformance-debt reason`);
    }
  });
  it('separates Web Streams behavioral coverage from WebIDL descriptor debt', (t) => {
    const idlEntry = entryByPath.get('streams/idlharness.any.js');
    t.ok(idlEntry !== undefined, 'streams/idlharness.any.js exists in manifest');
    t.equal(idlEntry?.runnable, false, 'streams/idlharness.any.js is skipped');
    t.equal(idlEntry?.reason, 'requires Web Streams WebIDL descriptor and brand-check conformance', 'streams idlharness has conformance-debt reason');
    for (const path of [
      'streams/readable-streams/general.any.js',
      'streams/transform-streams/general.any.js',
      'streams/writable-streams/general.any.js'
    ]) {
      const entry = entryByPath.get(path);
      t.ok(entry !== undefined, `${path} exists in manifest`);
      t.equal(entry?.runnable, true, `${path} remains runnable`);
      t.equal(entry?.reason, null, `${path} has no skip reason`);
    }
  });
});
