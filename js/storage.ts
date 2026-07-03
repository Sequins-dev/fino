/**
* fino:storage - S3-compatible object storage and an async filesystem adapter.
*
* AWS Signature Version 4 reference:
* https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
*
* The module signs S3-compatible HTTP requests, creates presigned URLs, exposes
* a small object client, and maps object keys onto the `FileSystem` provider
* contract. The filesystem is async and object-store-shaped; it does not claim
* SQLite VFS compatibility because that path currently requires synchronous
* provider methods.
*/
import { hmac, digest } from './internal/openssl.ts';
import { base64urlEncode, toBytes } from './internal/security/encoding.ts';
import { FileSystem, type ByteWriter, type FileHandle } from 'internal:file/provider';
import { Stat } from 'internal:file/stat';
import type { Path } from './file/path.ts';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Object metadata returned by `headObject()`. */
export interface S3ObjectHead {
  size: number;
  etag: string | null;
}

/** One object summary returned by `listObjectsV2()`. */
export interface S3ObjectSummary {
  key: string;
  size: number;
  etag?: string;
  lastModified?: string;
}

/** Result of an S3 multipart upload creation. */
export interface S3MultipartUpload {
  key: string;
  uploadId: string;
}

/** One uploaded multipart part. */
export interface S3UploadedPart {
  partNumber: number;
  etag: string;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function shortDate(date: Date): string {
  return amzDate(date).slice(0, 8);
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/');
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()].sort(([a, av], [b, bv]) => a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1).map(([k, v]) => `${encodeURIComponent(k).replace(/%20/g, '+')}=${encodeURIComponent(v).replace(/%20/g, '+')}`).join('&');
}

function signingKey(secret: string, date: string, region: string, service: string): Uint8Array {
  const kDate = hmac('sha-256', toBytes(`AWS4${secret}`), toBytes(date));
  const kRegion = hmac('sha-256', kDate, toBytes(region));
  const kService = hmac('sha-256', kRegion, toBytes(service));
  return hmac('sha-256', kService, toBytes('aws4_request'));
}

/** Sign an S3-compatible HTTP request with AWS Signature Version 4. */
export async function signS3Request(input: Request, options: {
  region: string;
  service?: string;
  credentials: S3Credentials;
  now?: Date;
  payloadHash?: string;
}): Promise<Request> {
  const now = options.now ?? new Date();
  const service = options.service ?? 's3';
  const date = shortDate(now);
  const stamp = amzDate(now);
  const url = new URL(input.url);
  const headers = new Headers(input.headers);
  headers.set('host', url.host);
  headers.set('x-amz-date', stamp);
  if (options.credentials.sessionToken !== undefined) headers.set('x-amz-security-token', options.credentials.sessionToken);
  const payloadHash = options.payloadHash ?? 'UNSIGNED-PAYLOAD';
  headers.set('x-amz-content-sha256', payloadHash);
  const sorted = [...headers.entries()].map(([k, v]) => [k.toLowerCase(), v.trim()] as [string, string]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const signedHeaders = sorted.map(([k]) => k).join(';');
  const canonicalHeaders = sorted.map(([k, v]) => `${k}:${v}\n`).join('');
  const canonical = [input.method.toUpperCase(), encodePath(url.pathname || '/'), canonicalQuery(url.searchParams), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${options.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, hex(digest('sha-256', toBytes(canonical)))].join('\n');
  const signature = hex(hmac('sha-256', signingKey(options.credentials.secretAccessKey, date, options.region, service), toBytes(stringToSign)));
  headers.set('authorization', `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
  for (const [name, value] of headers) input.headers.set(name, value);
  return input;
}

/** Create a presigned S3 URL for browser or third-party upload/download flows. */
export async function presignS3Url(method: string, urlInput: string | URL, options: {
  region: string;
  service?: string;
  credentials: S3Credentials;
  now?: Date;
  expiresIn?: number;
}): Promise<URL> {
  const now = options.now ?? new Date();
  const service = options.service ?? 's3';
  const date = shortDate(now);
  const stamp = amzDate(now);
  const scope = `${date}/${options.region}/${service}/aws4_request`;
  const url = new URL(urlInput);
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${options.credentials.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', stamp);
  url.searchParams.set('X-Amz-Expires', String(options.expiresIn ?? 900));
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  if (options.credentials.sessionToken !== undefined) url.searchParams.set('X-Amz-Security-Token', options.credentials.sessionToken);
  const canonical = [method.toUpperCase(), encodePath(url.pathname || '/'), canonicalQuery(url.searchParams), `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, hex(digest('sha-256', toBytes(canonical)))].join('\n');
  const signature = hex(hmac('sha-256', signingKey(options.credentials.secretAccessKey, date, options.region, service), toBytes(stringToSign)));
  url.searchParams.set('X-Amz-Signature', signature);
  return url;
}

/** Error raised for non-success S3 responses. */
export class S3Error extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class S3Client {
  #endpoint: string;
  #region: string;
  #bucket?: string;
  #credentials: S3Credentials;
  #fetch: typeof fetch;
  #clock: () => Date;
  #forcePathStyle: boolean;
  /** Create an S3-compatible client with injectable fetch and clock hooks. */
  constructor(options: { endpoint?: string; region: string; bucket?: string; credentials: S3Credentials; forcePathStyle?: boolean; fetch?: typeof fetch; clock?: () => Date }) {
    this.#endpoint = options.endpoint ?? 'https://s3.amazonaws.com';
    this.#region = options.region;
    this.#bucket = options.bucket;
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? (() => new Date());
    this.#forcePathStyle = options.forcePathStyle === true;
  }
  #url(key = '', query?: Record<string, string | undefined>): string {
    const endpoint = new URL(this.#endpoint);
    const bucket = this.#bucket;
    const cleanKey = key.replace(/^\/+/, '').split('/').filter((part, index, arr) => part.length > 0 || index < arr.length - 1).map(encodeURIComponent).join('/');
    if (bucket !== undefined && !this.#forcePathStyle) {
      endpoint.hostname = `${bucket}.${endpoint.hostname}`;
      endpoint.pathname = cleanKey.length > 0 ? `/${cleanKey}` : '/';
    } else {
      endpoint.pathname = [bucket, cleanKey].filter((part) => part !== undefined && part.length > 0).join('/');
      endpoint.pathname = '/' + endpoint.pathname;
    }
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) endpoint.searchParams.set(name, value);
    }
    return endpoint.toString();
  }
  async #request(method: string, key: string, body?: BodyInit, query?: Record<string, string | undefined>): Promise<Response> {
    const req = await signS3Request(new Request(this.#url(key, query), { method, body }), {
      region: this.#region,
      credentials: this.#credentials,
      now: this.#clock(),
      payloadHash: 'UNSIGNED-PAYLOAD'
    });
    const res = await this.#fetch(req);
    if (!res.ok) throw new S3Error(`S3 ${method} ${key} failed with HTTP ${res.status}`, res.status);
    return res;
  }
  /** Load object metadata with `HEAD`. */
  async headObject(key: string): Promise<S3ObjectHead> {
    const res = await this.#request('HEAD', key);
    return { size: Number(res.headers.get('content-length') ?? 0), etag: res.headers.get('etag') };
  }
  /** Download an object as a standard `Response`. */
  async getObject(key: string): Promise<Response> {
    return await this.#request('GET', key);
  }
  /** Upload or replace an object. */
  async putObject(key: string, body: BodyInit): Promise<void> {
    await this.#request('PUT', key, body);
  }
  /** Delete an object if it exists. */
  async deleteObject(key: string): Promise<void> {
    await this.#request('DELETE', key);
  }
  /** List objects with the S3 ListObjectsV2 API. */
  async listObjectsV2(options: { prefix?: string; continuationToken?: string; maxKeys?: number } = {}): Promise<{ objects: S3ObjectSummary[]; isTruncated: boolean; nextContinuationToken?: string }> {
    const res = await this.#request('GET', '', undefined, {
      'list-type': '2',
      prefix: options.prefix,
      'continuation-token': options.continuationToken,
      'max-keys': options.maxKeys === undefined ? undefined : String(options.maxKeys)
    });
    const text = await res.text();
    const objects = [...text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => {
      const block = match[1]!;
      return {
        key: /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1] ?? '',
        size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0),
        etag: /<ETag>"?([\s\S]*?)"?<\/ETag>/.exec(block)?.[1],
        lastModified: /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1]
      };
    });
    return {
      objects,
      isTruncated: /<IsTruncated>true<\/IsTruncated>/.test(text),
      nextContinuationToken: /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(text)?.[1]
    };
  }
  /** Start a multipart upload and return its upload id. */
  async createMultipartUpload(key: string): Promise<S3MultipartUpload> {
    const res = await this.#request('POST', key, undefined, { uploads: '' });
    const text = await res.text();
    return { key, uploadId: /<UploadId>([\s\S]*?)<\/UploadId>/.exec(text)?.[1] ?? '' };
  }
  /** Upload one multipart part. */
  async uploadPart(key: string, uploadId: string, partNumber: number, body: BodyInit): Promise<S3UploadedPart> {
    const res = await this.#request('PUT', key, body, { uploadId, partNumber: String(partNumber) });
    return { partNumber, etag: res.headers.get('etag') ?? '' };
  }
  /** Complete a multipart upload with uploaded part metadata. */
  async completeMultipartUpload(key: string, uploadId: string, parts: readonly S3UploadedPart[]): Promise<void> {
    const body = `<CompleteMultipartUpload>${parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    await this.#request('POST', key, body, { uploadId });
  }
  /** Abort a multipart upload. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.#request('DELETE', key, undefined, { uploadId });
  }
  /** Convenience multipart upload using fixed-size chunks. */
  async multipartUpload(key: string, chunks: readonly BodyInit[]): Promise<void> {
    const upload = await this.createMultipartUpload(key);
    const parts: S3UploadedPart[] = [];
    try {
      for (let i = 0; i < chunks.length; i++) parts.push(await this.uploadPart(key, upload.uploadId, i + 1, chunks[i]!));
      await this.completeMultipartUpload(key, upload.uploadId, parts);
    } catch (err) {
      await this.abortMultipartUpload(key, upload.uploadId);
      throw err;
    }
  }
}

class S3File implements FileHandle {
  readonly path: Path;
  closed = false;
  #client: S3Client;
  #key: string;
  #mode: string;
  #buffer: Uint8Array | null = null;
  constructor(client: S3Client, key: string, path: Path, mode: string) {
    this.#client = client;
    this.#key = key;
    this.path = path;
    this.#mode = mode;
  }
  async stat(): Promise<Stat> {
    const head = await this.#client.headObject(this.#key);
    return new Stat(0, 0, 0o100644, 1, 0, 0, 0, head.size, 4096, 1, Date.now(), Date.now(), Date.now(), Date.now());
  }
  async *reader(): AsyncIterable<Uint8Array> {
    yield await this.bytes();
  }
  writer(): ByteWriter {
    const chunks: Uint8Array[] = [];
    return {
      write(data) {
        chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
      },
      flush: async () => {
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.#buffer = out;
        await this.#client.putObject(this.#key, out);
      },
      close: async () => {}
    };
  }
  async bytes(): Promise<Uint8Array> {
    if (this.#mode.includes('w') && this.#buffer !== null) return this.#buffer;
    return await (await this.#client.getObject(this.#key)).bytes();
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }
  async pread(pos: number | bigint, len: number): Promise<Uint8Array> {
    return (await this.bytes()).subarray(Number(pos), Number(pos) + len);
  }
  async pwrite(_pos: number | bigint, _data: Uint8Array): Promise<number> {
    throw new Error('S3FileSystem positional writes are not supported');
  }
  async sync(): Promise<void> {}
  async truncate(_len: number | bigint): Promise<void> {
    throw new Error('S3FileSystem truncate is not supported');
  }
  async size(): Promise<bigint> {
    return BigInt((await this.stat()).size);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

export class S3FileSystem extends FileSystem {
  /** Create an async filesystem view over an S3 key prefix. */
  constructor(readonly client: S3Client, readonly prefix = '') {
    super();
  }
  #key(path: Path | string): string {
    return `${this.prefix}${String(path).replace(/^\/+/, '')}`;
  }
  async stat(path: Path | string): Promise<Stat> {
    const head = await this.client.headObject(this.#key(path));
    return new Stat(0, 0, 0o100644, 1, 0, 0, 0, head.size, 4096, 1, Date.now(), Date.now(), Date.now(), Date.now());
  }
  async lstat(path: Path | string): Promise<Stat> {
    return await this.stat(path);
  }
  async open(path: Path | string, mode = 'r'): Promise<FileHandle> {
    return new S3File(this.client, this.#key(path), path as Path, mode);
  }
  async dir(_path: Path | string): Promise<unknown> {
    throw new Error('S3FileSystem directory handles are not supported in v1');
  }
  async entry(_path: Path | string): Promise<unknown> {
    throw new Error('S3FileSystem entries are not supported in v1');
  }
  async mkdir(_path: Path | string): Promise<void> {}
  async rmdir(_path: Path | string): Promise<void> {}
  async unlink(path: Path | string): Promise<void> {
    await this.client.deleteObject(this.#key(path));
  }
  async rename(_oldPath: Path | string, _newPath: Path | string): Promise<void> {
    throw new Error('S3FileSystem rename is not supported in v1');
  }
  async readlink(_path: Path | string): Promise<string> {
    throw new Error('S3FileSystem symlinks are not supported');
  }
  async symlink(_target: Path | string, _linkpath: Path | string): Promise<void> {
    throw new Error('S3FileSystem symlinks are not supported');
  }
  async realpath(path: Path | string): Promise<string> {
    return '/' + this.#key(path);
  }
}

export { base64urlEncode };
