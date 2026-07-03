/**
* internal:database/postgres/scram — Postgres password authentication helpers.
*
* Implements PostgreSQL MD5 password responses and SCRAM-SHA-256 client proof
* generation for the PostgreSQL frontend/backend protocol.
*
* @internal
*/
import { digest, hmac, pbkdf2 } from '../../openssl.ts';
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytes(value: string): Uint8Array {
  return enc.encode(value);
}
function hex(input: Uint8Array): string {
  return Array.from(input, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function base64(input: Uint8Array): string {
  let out = '';
  for (let index = 0; index < input.length; index += 3) {
    const a = input[index]!;
    const b = input[index + 1];
    const c = input[index + 2];
    out += b64chars[a >> 2];
    out += b === undefined ? b64chars[(a & 3) << 4] + '==' : b64chars[((a & 3) << 4) | (b >> 4)];
    if (b !== undefined) out += c === undefined ? b64chars[(b & 15) << 2] + '=' : b64chars[((b & 15) << 2) | (c >> 6)] + b64chars[c & 63];
  }
  return out;
}
function unbase64(value: string): Uint8Array {
  const clean = value.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const n = b64chars.indexOf(ch);
    if (n < 0) throw new Error('Invalid base64');
    buffer = (buffer << 6) | n;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}
function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let index = 0; index < a.length; index++) out[index] = a[index]! ^ b[index]!;
  return out;
}
function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const part of input.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) throw new Error(`Invalid SCRAM attribute: ${part}`);
    attrs[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return attrs;
}
function saslName(name: string): string {
  return name.replace(/=/g, '=3D').replace(/,/g, '=2C');
}
export function md5Password(password: string, user: string, salt: Uint8Array): string {
  const inner = hex(md5(bytes(password + user)));
  return 'md5' + hex(md5(new Uint8Array([...bytes(inner), ...salt])));
}
function md5(data: Uint8Array): Uint8Array {
  const msgLen = data.length;
  const bitLen = msgLen * 8;
  const paddedLen = (((msgLen + 8) >>> 6) + 1) << 6;
  const msg = new Uint8Array(paddedLen);
  msg.set(data);
  msg[msgLen] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const k = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    const m = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, true));
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + k[i]! + m[g]!) >>> 0;
      b = (b + ((sum << s[i]!) | (sum >>> (32 - s[i]!)))) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}
export class ScramSha256Client {
  readonly #password: string;
  readonly #nonce: string;
  #clientFirstBare = '';
  #serverSignature: string | null = null;
  constructor(password: string, nonce?: string) {
    this.#password = password;
    this.#nonce = nonce ?? base64(crypto.getRandomValues(new Uint8Array(18)));
  }
  firstMessageBare(user: string): string {
    this.#clientFirstBare = `n=${saslName(user)},r=${this.#nonce}`;
    return this.#clientFirstBare;
  }
  initialResponse(user: string): string {
    return `n,,${this.firstMessageBare(user)}`;
  }
  async finalMessage(serverFirst: string): Promise<string> {
    const attrs = parseAttributes(serverFirst);
    const nonce = attrs.r;
    if (!nonce?.startsWith(this.#nonce)) throw new Error('SCRAM server nonce does not extend client nonce');
    const salt = unbase64(attrs.s ?? '');
    const iterations = Number(attrs.i);
    if (!Number.isInteger(iterations) || iterations <= 0) throw new Error('Invalid SCRAM iteration count');
    const clientFinalWithoutProof = `c=biws,r=${nonce}`;
    const authMessage = `${this.#clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
    const saltedPassword = pbkdf2(bytes(this.#password), salt, iterations, 'sha-256', 32);
    const clientKey = hmac('sha-256', saltedPassword, bytes('Client Key'));
    const storedKey = digest('sha-256', clientKey);
    const clientSignature = hmac('sha-256', storedKey, bytes(authMessage));
    const clientProof = xor(clientKey, clientSignature);
    const serverKey = hmac('sha-256', saltedPassword, bytes('Server Key'));
    this.#serverSignature = base64(hmac('sha-256', serverKey, bytes(authMessage)));
    return `${clientFinalWithoutProof},p=${base64(clientProof)}`;
  }
  async verifyServerFinal(serverFinal: string): Promise<void> {
    const attrs = parseAttributes(serverFinal);
    if (!this.#serverSignature || attrs.v !== this.#serverSignature) throw new Error('SCRAM server signature mismatch');
  }
}
