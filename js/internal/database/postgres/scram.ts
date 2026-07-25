/**
* internal:database/postgres/scram — Postgres password authentication helpers.
*
* Implements the two password-based authentication exchanges of the
* PostgreSQL frontend/backend protocol: the legacy MD5 challenge/response
* (`AuthenticationMD5Password`, code 5) and SCRAM-SHA-256 SASL
* authentication (`AuthenticationSASL`, codes 10–12). The `fino:database`
* postgres driver consumes both from its authentication handler; nothing
* here touches the wire — callers feed it the decoded text payloads of
* backend messages and send back the strings it produces.
*
* SCRAM state lives in a `ScramSha256Client` instance: one instance per
* connection attempt, driven through `initialResponse` → `finalMessage` →
* `verifyServerFinal` in that order. The client advertises no channel
* binding (GS2 header `n,,`), matching what PostgreSQL accepts on both
* plain and TLS connections when the server was not started with
* channel-binding enforcement. Passwords are fed to PBKDF2 as raw UTF-8
* bytes without SASLprep normalization, which matches the behavior of
* common drivers for ASCII passwords.
*
* SHA-256 primitives (PBKDF2, HMAC, digest) come from `internal:openssl`.
* MD5 is implemented locally in pure JS because hardened libcrypto builds
* (FIPS providers) often omit it, yet `md5Password` must keep working
* against servers configured for `md5` auth.
*
* ```ts no_run
* import { ScramSha256Client, md5Password } from 'internal:database/postgres/scram';
*
* // SCRAM-SHA-256 (AuthenticationSASL): three messages per handshake.
* const scram = new ScramSha256Client(password);
* send(saslInitialResponse('SCRAM-SHA-256', scram.initialResponse(user)));
* const challenge = await recvText();               // AuthenticationSASLContinue
* send(saslResponse(await scram.finalMessage(challenge)));
* await scram.verifyServerFinal(await recvText());  // AuthenticationSASLFinal
*
* // Legacy MD5 (AuthenticationMD5Password): single response.
* send(passwordMessage(md5Password(password, user, saltFromServer)));
* ```
*
* SCRAM-SHA-256 mechanism: https://www.rfc-editor.org/rfc/rfc7677
* SCRAM framework and message grammar: https://www.rfc-editor.org/rfc/rfc5802
* PostgreSQL password authentication: https://www.postgresql.org/docs/current/auth-password.html
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
    out += b === undefined ? b64chars[(a & 3) << 4] + '==' : b64chars[(a & 3) << 4 | b >> 4];
    if (b !== undefined) out += c === undefined ? b64chars[(b & 15) << 2] + '=' : b64chars[(b & 15) << 2 | c >> 6] + b64chars[c & 63];
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
    buffer = buffer << 6 | n;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push(buffer >> bits & 255);
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
/**
* Computes the response string for PostgreSQL `md5` authentication.
*
* The server sends a four-byte salt in its `AuthenticationMD5Password`
* message; this returns the string the client puts in the following
* `PasswordMessage`. The construction is PostgreSQL's own double-MD5 scheme,
* not a bare hash: `md5(md5(password + user) + salt)` rendered as lowercase
* hex and prefixed with the literal `md5`. Both the password and the username
* are hashed as raw UTF-8 bytes, so the username must be the same role name
* used to connect.
*
* MD5 authentication is deprecated in favor of SCRAM but remains in wide use
* on older servers and `pg_hba.conf` entries; this helper keeps working even
* on hardened libcrypto builds because MD5 is computed in pure JS here rather
* than through OpenSSL.
*
* ```ts no_run
* import { md5Password } from 'internal:database/postgres/scram';
*
* // salt arrives as the 4-byte body of AuthenticationMD5Password.
* const salt = new Uint8Array([0x2a, 0x1f, 0x9c, 0x04]);
* const response = md5Password('s3cret', 'ada', salt);
* // response looks like 'md5a1b2c3…'; send it as the PasswordMessage body.
* send(passwordMessage(response));
* ```
*/
export function md5Password(password: string, user: string, salt: Uint8Array): string {
  const inner = hex(md5(bytes(password + user)));
  return 'md5' + hex(md5(new Uint8Array([...bytes(inner), ...salt])));
}
function md5(data: Uint8Array): Uint8Array {
  const msgLen = data.length;
  const bitLen = msgLen * 8;
  const paddedLen = (msgLen + 8 >>> 6) + 1 << 6;
  const msg = new Uint8Array(paddedLen);
  msg.set(data);
  msg[msgLen] = 128;
  const view = new DataView(msg.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 4294967296), true);
  let a0 = 1732584193;
  let b0 = 4023233417;
  let c0 = 2562383102;
  let d0 = 271733878;
  const s = [
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21
  ];
  const k = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    const m = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, true));
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) {
        f = b & c | ~b & d;
        g = i;
      } else if (i < 32) {
        f = d & b | ~d & c;
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = 7 * i % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = a + f + k[i]! + m[g]! >>> 0;
      b = b + (sum << s[i]! | sum >>> 32 - s[i]!) >>> 0;
      a = tmp;
    }
    a0 = a0 + a >>> 0;
    b0 = b0 + b >>> 0;
    c0 = c0 + c >>> 0;
    d0 = d0 + d >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}
/**
* Drives one client-side SCRAM-SHA-256 SASL handshake for PostgreSQL.
*
* Create one instance per connection attempt and step it through the three
* messages of the exchange, in order: `initialResponse` (sent inside the
* `SASLInitialResponse`), then `finalMessage` with the server's first
* challenge (sent inside the `SASLResponse`), then `verifyServerFinal` with
* the server's final message. The instance holds the mutable state that ties
* those steps together — the client nonce, the client-first-message-bare, and
* the expected server signature — so the calls are not reentrant and must not
* be interleaved across connections.
*
* The client advertises no channel binding (GS2 header `n,,`), which
* PostgreSQL accepts on both plain and TLS connections unless the server was
* configured to require channel binding. Passwords are fed to PBKDF2 as raw
* UTF-8 bytes without SASLprep normalization, matching common drivers for
* ASCII passwords.
*
* ```ts no_run
* import { ScramSha256Client } from 'internal:database/postgres/scram';
*
* const scram = new ScramSha256Client(password);
* send(saslInitialResponse('SCRAM-SHA-256', scram.initialResponse(user)));
*
* const serverFirst = await recvText();   // AuthenticationSASLContinue body
* send(saslResponse(await scram.finalMessage(serverFirst)));
*
* const serverFinal = await recvText();   // AuthenticationSASLFinal body
* await scram.verifyServerFinal(serverFinal);  // throws on mismatch
* ```
*/
export class ScramSha256Client {
  readonly #password: string;
  readonly #nonce: string;
  #clientFirstBare = '';
  #serverSignature: string | null = null;
  /**
  * Creates a client bound to a password, optionally with a fixed nonce.
  *
  * The password is retained for the PBKDF2 step performed later in
  * `finalMessage`. The `nonce` parameter exists for deterministic testing;
  * when omitted, a fresh 18-byte random value is drawn from `crypto` and
  * base64-encoded, which is what production code should always do — reusing a
  * nonce across handshakes defeats the replay protection SCRAM is built on.
  *
  * ```ts no_run
  * import { ScramSha256Client } from 'internal:database/postgres/scram';
  *
  * const client = new ScramSha256Client(password);      // random nonce
  * const fixed = new ScramSha256Client('pencil', 'fyko+d2lbbFgONRv9qkxdawL');
  * ```
  */
  constructor(password: string, nonce?: string) {
    this.#password = password;
    this.#nonce = nonce ?? base64(crypto.getRandomValues(new Uint8Array(18)));
  }
  /**
  * Builds and records the client-first-message-bare for a username.
  *
  * Returns the `n=<user>,r=<nonce>` portion of the client's first message
  * (without the GS2 header), and stores it internally because it is later
  * folded into the auth message that `finalMessage` signs. The username is
  * SASL-escaped: `=` becomes `=3D` and `,` becomes `=2C`, so role names
  * containing those characters round-trip correctly. Most callers use
  * `initialResponse` instead, which wraps this with the GS2 header; call this
  * directly only when assembling the message framing by hand.
  *
  * ```ts no_run
  * import { ScramSha256Client } from 'internal:database/postgres/scram';
  *
  * const client = new ScramSha256Client('pencil', 'fyko+d2lbbFgONRv9qkxdawL');
  * client.firstMessageBare('user'); // 'n=user,r=fyko+d2lbbFgONRv9qkxdawL'
  * ```
  */
  firstMessageBare(user: string): string {
    this.#clientFirstBare = `n=${saslName(user)},r=${this.#nonce}`;
    return this.#clientFirstBare;
  }
  /**
  * Produces the client's first SCRAM message, GS2 header included.
  *
  * This is the string that goes in the `SASLInitialResponse` sent after the
  * server's `AuthenticationSASL`. It prepends the no-channel-binding GS2
  * header `n,,` to the client-first-message-bare, and as a side effect
  * records that bare portion for the later signature step, so this must be
  * called before `finalMessage`.
  *
  * ```ts no_run
  * import { ScramSha256Client } from 'internal:database/postgres/scram';
  *
  * const scram = new ScramSha256Client(password);
  * const first = scram.initialResponse('ada'); // 'n,,n=ada,r=<nonce>'
  * send(saslInitialResponse('SCRAM-SHA-256', first));
  * ```
  */
  initialResponse(user: string): string {
    return `n,,${this.firstMessageBare(user)}`;
  }
  /**
  * Computes the client-final message from the server's first challenge.
  *
  * Given the `AuthenticationSASLContinue` body — the server's
  * `r=<nonce>,s=<salt>,i=<iterations>` challenge — this derives the salted
  * password with PBKDF2-HMAC-SHA-256, builds the client proof, and returns
  * the `c=biws,r=<nonce>,p=<proof>` string to send in the `SASLResponse`. It
  * also stashes the expected server signature so `verifyServerFinal` can
  * check it afterward. `c=biws` is the base64 of the `n,,` GS2 header,
  * consistent with `initialResponse`.
  *
  * Throws if the server's combined nonce does not start with this client's
  * nonce (a sign of a tampered or mismatched exchange), or if the advertised
  * iteration count is missing, non-integer, or not positive.
  *
  * ```ts no_run
  * import { ScramSha256Client } from 'internal:database/postgres/scram';
  *
  * const client = new ScramSha256Client('pencil', 'fyko+d2lbbFgONRv9qkxdawL');
  * client.initialResponse('user');
  * const final = await client.finalMessage(
  *   'r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,s=QSXCR+Q6sek8bf92,i=4096',
  * );
  * // 'c=biws,r=…,p=qQRLRHGPDGjB+7iVAE7NNi5xEoHKHuLCHPNQ8BTmvds='
  * send(saslResponse(final));
  * ```
  */
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
  /**
  * Authenticates the server from its final SCRAM message.
  *
  * SCRAM is mutual: the server proves it knows the stored key by returning a
  * `v=<signature>` in its `AuthenticationSASLFinal` message. This parses that
  * message and compares the `v` attribute against the server signature
  * computed during `finalMessage`, so it must be called after `finalMessage`
  * on the same instance. Resolving means the server is authenticated and the
  * handshake succeeded; nothing is returned.
  *
  * Throws if `finalMessage` has not run yet (no expected signature is on
  * hand) or if the server's signature does not match — a mismatch means the
  * server did not know the password's stored key and must not be trusted.
  *
  * ```ts no_run
  * import { ScramSha256Client } from 'internal:database/postgres/scram';
  *
  * const client = new ScramSha256Client('pencil', 'fyko+d2lbbFgONRv9qkxdawL');
  * client.initialResponse('user');
  * await client.finalMessage('r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,s=QSXCR+Q6sek8bf92,i=4096');
  * await client.verifyServerFinal('v=XKW6VuW1FANROQabnJBz1KaeCnQL/HZByQtX/iU+o30=');
  * ```
  */
  async verifyServerFinal(serverFinal: string): Promise<void> {
    const attrs = parseAttributes(serverFinal);
    if (!this.#serverSignature || attrs.v !== this.#serverSignature) throw new Error('SCRAM server signature mismatch');
  }
}
