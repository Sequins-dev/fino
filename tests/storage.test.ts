import { describe, it } from 'fino:test/test';
import { S3Client, S3FileSystem, presignS3Url, signS3Request } from 'fino:storage';
const credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
};
describe('fino:storage', () => {
  it('signs S3 requests and presigned URLs with SigV4', async (t) => {
    const signed = await signS3Request(new Request('https://examplebucket.s3.amazonaws.com/test.txt'), {
      region: 'us-east-1',
      service: 's3',
      credentials,
      now: new Date('2013-05-24T00:00:00Z'),
      payloadHash: 'UNSIGNED-PAYLOAD'
    });
    t.equal(signed.headers.get('x-amz-date'), '20130524T000000Z');
    t.ok((signed.headers.get('authorization') ?? '').startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20130524/us-east-1/s3/aws4_request'), 'authorization header is SigV4');
    const url = await presignS3Url('GET', 'https://examplebucket.s3.amazonaws.com/test.txt', {
      region: 'us-east-1',
      credentials,
      now: new Date('2013-05-24T00:00:00Z'),
      expiresIn: 60
    });
    t.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    t.equal(url.searchParams.get('X-Amz-Expires'), '60');
    t.ok(url.searchParams.get('X-Amz-Signature')!.length > 0, 'signature is present');
  });
  it('maps S3 client methods to signed HTTP requests', async (t) => {
    const calls: Request[] = [];
    const client = new S3Client({
      endpoint: 'https://s3.example.test',
      region: 'us-test-1',
      bucket: 'bucket',
      credentials,
      fetch: async (req) => {
        calls.push(req);
        if (req.method === 'HEAD') return new Response(null, { headers: {
          'content-length': '5',
          etag: '"e"'
        } });
        return new Response('hello');
      },
      clock: () => new Date('2020-01-02T03:04:05Z')
    });
    const head = await client.headObject('a.txt');
    t.equal(head.size, 5);
    const got = await client.getObject('a.txt');
    t.equal(await got.text(), 'hello');
    t.equal(calls[0]!.method, 'HEAD');
    t.equal(calls[1]!.method, 'GET');
    t.equal(calls[1]!.url, 'https://bucket.s3.example.test/a.txt');
    t.ok(calls[1]!.headers.has('authorization'), 'request is signed');
  });
  it('provides an async object-backed FileSystem', async (t) => {
    const objects = new Map<string, Uint8Array>();
    const fs = new S3FileSystem(new S3Client({
      endpoint: 'https://s3.example.test',
      region: 'us-test-1',
      bucket: 'bucket',
      credentials,
      fetch: async (req) => {
        const key = new URL(req.url).pathname.slice(1);
        if (req.method === 'PUT') {
          objects.set(key, await req.bytes());
          return new Response('');
        }
        if (req.method === 'GET') return new Response(objects.get(key) ?? new Uint8Array());
        if (req.method === 'HEAD') return new Response(null, {
          status: objects.has(key) ? 200 : 404,
          headers: { 'content-length': String(objects.get(key)?.byteLength ?? 0) }
        });
        if (req.method === 'DELETE') {
          objects.delete(key);
          return new Response('');
        }
        return new Response('<ListBucketResult></ListBucketResult>');
      }
    }));
    await fs.writeFile('/note.txt', new TextEncoder().encode('hello'));
    t.equal(new TextDecoder().decode(await fs.readFile('/note.txt')), 'hello');
    t.equal((await fs.stat('/note.txt')).size, 5);
    await fs.unlink('/note.txt');
    await t.rejects(() => fs.stat('/note.txt'), /S3/);
  });
});
