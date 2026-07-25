import { describe, it } from 'fino:test/test';
import { ScramSha256Client, md5Password } from 'internal:database/postgres/scram';
describe('Postgres password authentication helpers', () => {
  it('computes PostgreSQL MD5 password responses', (t) => {
    t.equal(md5Password('secret', 'ada', new Uint8Array([1, 2, 3, 4])), 'md5164dbcd37c01a78e869e72965960a754');
  });
  it('computes SCRAM-SHA-256 client-final messages and verifies server signatures', async (t) => {
    const client = new ScramSha256Client('pencil', 'fyko+d2lbbFgONRv9qkxdawL');
    t.equal(client.firstMessageBare('user'), 'n=user,r=fyko+d2lbbFgONRv9qkxdawL');
    const final = await client.finalMessage('r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,s=QSXCR+Q6sek8bf92,i=4096');
    t.equal(final, 'c=biws,r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,p=qQRLRHGPDGjB+7iVAE7NNi5xEoHKHuLCHPNQ8BTmvds=');
    await client.verifyServerFinal('v=XKW6VuW1FANROQabnJBz1KaeCnQL/HZByQtX/iU+o30=');
    await t.rejects(() => client.verifyServerFinal('v=bad'), /SCRAM server signature/i);
  });
});
