/**
 * fino:email - transactional email messages, SMTP delivery, and DKIM signing.
 *
 * The surface is deliberately small and composable: `renderMessage()` turns an
 * `EmailMessage` into RFC 5322/MIME text, `SmtpClient` drives a complete SMTP
 * submission transaction over a caller-supplied connection, `dkimSign()`
 * produces a `DKIM-Signature` header, and `send()` dispatches a message to any
 * `EmailTransport`. Application code should depend on the `EmailTransport`
 * interface so the delivery mechanism — direct SMTP, a hosted provider's HTTP
 * API, or an in-memory capture in tests — stays swappable. Hosted provider
 * adapters are expected to live in external packages that implement
 * `EmailTransport`; this module provides the message model and wire formats
 * they share.
 *
 * Rendering guards against header injection: any CR or LF in the sender,
 * recipients, subject, or attachment filenames throws, so those fields can be
 * populated from untrusted input without smuggling extra headers.
 *
 * ```ts no_run
 * import { send, type EmailTransport } from 'fino:email';
 *
 * const transport: EmailTransport = {
 *   async send(message) {
 *     // deliver via a provider API, an SmtpClient, etc.
 *     return { id: 'provider-1' };
 *   }
 * };
 *
 * const result = await send({
 *   from: 'Ada <ada@example.test>',
 *   to: 'ops@example.test',
 *   subject: 'Deploy finished',
 *   text: 'Deploy finished without errors.',
 *   html: '<p>Deploy finished <strong>without errors</strong>.</p>'
 * }, { transport });
 * ```
 *
 * Useful references:
 * - SMTP: https://www.rfc-editor.org/rfc/rfc5321
 * - Internet message format: https://www.rfc-editor.org/rfc/rfc5322
 * - STARTTLS for SMTP: https://www.rfc-editor.org/rfc/rfc3207
 * - SMTP AUTH: https://www.rfc-editor.org/rfc/rfc4954
 * - DKIM: https://www.rfc-editor.org/rfc/rfc6376
 */
import { hmac, digest } from './internal/openssl.ts';
import { base64urlEncode, toBytes } from './internal/security/encoding.ts';

/**
 * Mailbox address used in sender and recipient fields.
 *
 * Accepts either a bare address (`ada@example.test`) or the display-name form
 * (`Ada Lovelace <ada@example.test>`). `renderMessage()` emits the value
 * verbatim in headers, while `SmtpClient` extracts the angle-bracket address
 * for the SMTP envelope.
 */
export type EmailAddress = string;

/**
 * Message to render or deliver.
 *
 * Provide at least one of `text` or `html`; when both are present the message
 * renders as `multipart/alternative` so receiving clients pick their preferred
 * body. The optional `date`, `messageId`, and `boundary` fields exist mainly
 * to make rendered output deterministic in tests — production callers can
 * leave them unset and let `renderMessage()` fill in defaults.
 *
 * ```ts no_run
 * import type { EmailMessage } from 'fino:email';
 *
 * const message: EmailMessage = {
 *   from: 'Ada <ada@example.test>',
 *   to: ['ops@example.test', 'dev@example.test'],
 *   subject: 'Nightly report',
 *   text: 'All 412 checks passed.',
 *   html: '<p>All <strong>412</strong> checks passed.</p>'
 * };
 * ```
 */
export interface EmailMessage {
  /** Sender mailbox, rendered as the `From` header and used for the SMTP envelope sender. */
  from: EmailAddress;
  /** One or more recipient mailboxes, rendered comma-separated in the `To` header. */
  to: EmailAddress | EmailAddress[];
  /** Subject line. Throws at render time if it contains CR or LF. */
  subject: string;
  /** Plain-text body, used alone or as the fallback part of a `multipart/alternative` message. */
  text?: string;
  /** HTML body. When `text` is also set, both render as `multipart/alternative`. */
  html?: string;
  /** Override for the `Date` header; defaults to the time of rendering. */
  date?: Date;
  /** Override for the `Message-ID` header; a generated `@fino.local` id is used when unset. */
  messageId?: string;
  /** Explicit MIME boundary base for deterministic output in tests; random when unset. */
  boundary?: string;
  /** Files to attach. Any attachment switches the top-level structure to `multipart/mixed`. */
  attachments?: EmailAttachment[];
}

/**
 * Attachment rendered into a MIME message.
 *
 * Every attachment part is emitted with `Content-Transfer-Encoding: base64`.
 * `Uint8Array` content is base64-encoded during rendering; string content is
 * emitted verbatim, so a string must already be base64 text.
 */
export interface EmailAttachment {
  /** Name presented in the part's `Content-Disposition`. Throws at render time if it contains CR or LF. */
  filename: string;
  /** MIME type of the part; defaults to `application/octet-stream`. */
  contentType?: string;
  /** Part payload: raw bytes to be base64-encoded, or a string that is already base64 text. */
  content: string | Uint8Array;
}

/**
 * Outcome reported by a transport after a send attempt.
 *
 * Which fields are populated depends on the transport: `SmtpClient` fills
 * `accepted` and `rejected` from the SMTP envelope, while hosted providers
 * typically return a provider-side message `id`.
 */
export interface EmailSendResult {
  /** Provider-assigned message identifier, when the transport supplies one. */
  id?: string;
  /** Envelope recipient addresses the transport accepted. */
  accepted?: string[];
  /** Envelope recipient addresses the transport refused. */
  rejected?: string[];
}

/**
 * Delivery backend accepted by `send()`.
 *
 * Implement this single-method interface to plug in any delivery mechanism:
 * an `SmtpClient`, a hosted provider's HTTP API, or an in-memory capture for
 * tests. Implementations may be synchronous or asynchronous and should throw
 * (or reject) when delivery fails outright.
 *
 * ```ts no_run
 * import { send, type EmailTransport } from 'fino:email';
 *
 * const providerTransport: EmailTransport = {
 *   async send(message) {
 *     const response = await fetch('https://api.mailer.test/v1/send', {
 *       method: 'POST',
 *       headers: { 'content-type': 'application/json' },
 *       body: JSON.stringify(message)
 *     });
 *     const { id } = await response.json();
 *     return { id };
 *   }
 * };
 *
 * await send({
 *   from: 'a@example.test',
 *   to: 'b@example.test',
 *   subject: 'Hello',
 *   text: 'Hi there'
 * }, { transport: providerTransport });
 * ```
 */
export interface EmailTransport {
  /** Deliver one message, resolving with whatever delivery metadata the backend reports. */
  send(message: EmailMessage): Promise<EmailSendResult> | EmailSendResult;
}

function assertHeader(value: string): void {
  if (/[\r\n]/.test(value)) throw new Error('Invalid email header value');
}

function list(value: EmailAddress | EmailAddress[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Render an email message as RFC 5322/MIME text.
 *
 * Lines use CRLF endings and the structure follows the message content: a
 * text-only or HTML-only message renders as a single part, text plus HTML
 * renders `multipart/alternative`, and any attachments promote the top level
 * to `multipart/mixed` (nesting the alternative part when both bodies are
 * present). Missing optional fields are filled with defaults — `Date` becomes
 * the current time, `Message-ID` a generated `@fino.local` id, and the MIME
 * boundary a random `fino-` token.
 *
 * Throws if `from`, `subject`, any recipient, or any attachment filename
 * contains CR or LF. This is the header-injection guard: it means those
 * fields can carry untrusted input without allowing extra headers to be
 * smuggled into the output.
 *
 * ```ts no_run
 * import { renderMessage } from 'fino:email';
 *
 * const raw = renderMessage({
 *   from: 'Ada <ada@example.test>',
 *   to: 'ops@example.test',
 *   subject: 'Nightly report',
 *   text: 'All 412 checks passed.',
 *   attachments: [{
 *     filename: 'report.csv',
 *     contentType: 'text/csv',
 *     content: new TextEncoder().encode('check,status\nlint,pass\n')
 *   }]
 * });
 * ```
 */
export function renderMessage(message: EmailMessage): string {
  assertHeader(message.from);
  assertHeader(message.subject);
  for (const to of list(message.to)) assertHeader(to);
  const boundary = message.boundary ?? `fino-${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${message.from}`,
    `To: ${list(message.to).join(', ')}`,
    `Subject: ${message.subject}`,
    `Date: ${(message.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${message.messageId ?? `<${Date.now().toString(36)}@fino.local>`}`,
    'MIME-Version: 1.0',
  ];
  let body: string;
  if (message.html !== undefined && message.text !== undefined) {
    body = `--${boundary}-alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message.text}\r\n--${boundary}-alt\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${message.html}\r\n--${boundary}-alt--\r\n`;
    if ((message.attachments?.length ?? 0) === 0) {
      headers.push(`Content-Type: multipart/alternative; boundary="${boundary}-alt"`);
      return headers.join('\r\n') + `\r\n\r\n${body}`;
    }
  } else if (message.html !== undefined) {
    body = `Content-Type: text/html; charset=utf-8\r\n\r\n${message.html}\r\n`;
  } else {
    body = `Content-Type: text/plain; charset=utf-8\r\n\r\n${message.text ?? ''}\r\n`;
  }
  if ((message.attachments?.length ?? 0) > 0) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [
      `--${boundary}\r\n${message.html !== undefined && message.text !== undefined ? `Content-Type: multipart/alternative; boundary="${boundary}-alt"\r\n\r\n${body}` : body}`,
    ];
    for (const attachment of message.attachments ?? []) {
      assertHeader(attachment.filename);
      const content =
        typeof attachment.content === 'string'
          ? attachment.content
          : btoa(String.fromCharCode(...attachment.content));
      parts.push(
        `--${boundary}\r\nContent-Type: ${attachment.contentType ?? 'application/octet-stream'}\r\nContent-Disposition: attachment; filename="${attachment.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${content}\r\n`,
      );
    }
    parts.push(`--${boundary}--\r\n`);
    return headers.join('\r\n') + '\r\n\r\n' + parts.join('');
  }
  return headers.join('\r\n') + '\r\n' + body;
}

/**
 * Send a message through an injected SMTP or provider transport.
 *
 * A thin dispatch helper: it awaits `options.transport.send(message)` and
 * returns the result, so application code depends on the `EmailTransport`
 * interface rather than on a concrete client. Errors thrown or rejected by the
 * transport propagate unchanged.
 *
 * ```ts no_run
 * import { send } from 'fino:email';
 *
 * const result = await send({
 *   from: 'a@example.test',
 *   to: 'b@example.test',
 *   subject: 'Welcome',
 *   text: 'Thanks for signing up.'
 * }, { transport: myTransport });
 *
 * console.log(result.id ?? result.accepted);
 * ```
 */
export async function send(
  message: EmailMessage,
  options: { transport: EmailTransport },
): Promise<EmailSendResult> {
  return await options.transport.send(message);
}

function b64(value: string): string {
  return btoa(value);
}

function dotStuff(data: string): string {
  return data
    .replace(/\r?\n/g, '\r\n')
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

/**
 * Minimal SMTP client that drives one complete submission transaction.
 *
 * The client is connection-agnostic: server replies are consumed from the
 * `reader` queue (an array of reply lines, copied at construction, so every
 * reply the transaction will need must be supplied up front in protocol
 * order) and commands go out through `writer.write()`, which may return a
 * promise. This shape makes scripted sessions and tests straightforward —
 * the caller owns whatever produced the replies.
 *
 * A single `send()` call performs the whole conversation: greeting, `EHLO`,
 * optional `AUTH PLAIN`, `MAIL FROM`, one `RCPT TO` per recipient, `DATA`
 * with the dot-stuffed rendered message, and `QUIT`.
 *
 * ```ts no_run
 * import { SmtpClient } from 'fino:email';
 *
 * const client = new SmtpClient({
 *   reader: [
 *     '220 mx.example.test ESMTP\r\n',
 *     '250-mx.example.test\r\n250 AUTH PLAIN LOGIN\r\n',
 *     '235 ok\r\n',
 *     '250 sender ok\r\n',
 *     '250 recipient ok\r\n',
 *     '354 go\r\n',
 *     '250 queued\r\n',
 *     '221 bye\r\n'
 *   ],
 *   writer: { write: (chunk) => socket.write(chunk) }
 * });
 *
 * const result = await client.send({
 *   from: 'a@example.test',
 *   to: 'b@example.test',
 *   subject: 'Hello',
 *   text: 'Hi there'
 * }, { username: 'user', password: 'pass' });
 * ```
 */
export class SmtpClient implements EmailTransport {
  #reader: string[];
  #writer: { write(chunk: string): void | Promise<void> };
  /** Capture the server reply queue (copied) and the command writer for the transaction. */
  constructor(connection: {
    reader: string[];
    writer: { write(chunk: string): void | Promise<void> };
  }) {
    this.#reader = [...connection.reader];
    this.#writer = connection.writer;
  }
  async #read(expect: number): Promise<string> {
    const line = this.#reader.shift() ?? '';
    const code = Number(line.slice(0, 3));
    if (code !== expect) throw new Error(`SMTP expected ${expect}, got ${line.trim()}`);
    return line;
  }
  async #write(line: string): Promise<void> {
    await this.#writer.write(line);
  }
  /**
   * Send one message through the SMTP transaction.
   *
   * Runs the full command sequence, checking the three-digit status code of
   * each queued reply and throwing on any unexpected code (for example
   * `SMTP expected 250, got 550 ...`). When `username` or `password` is
   * provided, the client issues `AUTH PLAIN` after `EHLO`. Envelope addresses
   * are extracted from angle-bracket display-name forms, and the rendered
   * message is dot-stuffed before the terminating `CRLF.CRLF`.
   *
   * Resolves with the accepted envelope recipients. `rejected` is always
   * empty in the result because a refused recipient aborts the transaction
   * with a throw instead of being collected.
   */
  async send(
    message: EmailMessage,
    options: { username?: string; password?: string } = {},
  ): Promise<EmailSendResult> {
    await this.#read(220);
    await this.#write('EHLO localhost\r\n');
    await this.#read(250);
    if (options.username !== undefined || options.password !== undefined) {
      await this.#write(
        `AUTH PLAIN ${b64(`\0${options.username ?? ''}\0${options.password ?? ''}`)}\r\n`,
      );
      await this.#read(235);
    }
    const from = /<([^>]+)>/.exec(message.from)?.[1] ?? message.from;
    await this.#write(`MAIL FROM:<${from}>\r\n`);
    await this.#read(250);
    const accepted: string[] = [];
    for (const rcpt of list(message.to)) {
      const addr = /<([^>]+)>/.exec(rcpt)?.[1] ?? rcpt;
      await this.#write(`RCPT TO:<${addr}>\r\n`);
      await this.#read(250);
      accepted.push(addr);
    }
    await this.#write('DATA\r\n');
    await this.#read(354);
    await this.#write(dotStuff(renderMessage(message)) + '\r\n.\r\n');
    await this.#read(250);
    await this.#write('QUIT\r\n');
    await this.#read(221);
    return { accepted, rejected: [] };
  }
}

/**
 * Use an `SmtpClient` wherever an `EmailTransport` is accepted.
 *
 * `SmtpClient` already implements `EmailTransport`, so this identity helper
 * only narrows the type: it keeps the client's SMTP-specific AUTH options out
 * of code written against the generic transport interface.
 *
 * ```ts no_run
 * import { SmtpClient, smtpTransport, send } from 'fino:email';
 *
 * const client = new SmtpClient({ reader: replies, writer: socket });
 * await send(message, { transport: smtpTransport(client) });
 * ```
 */
export function smtpTransport(client: SmtpClient): EmailTransport {
  return client;
}

/**
 * Create a `DKIM-Signature` header for a rendered message.
 *
 * Hashes the message body with SHA-256 to fill the `bh=` tag (base64url),
 * assembles the DKIM tag list
 * (`v=1; a=hmac-sha256; d=...; s=...; t=...; h=...; bh=...`), and signs that
 * tag list with HMAC-SHA256 keyed by `privateKey` to fill the `b=` tag (also
 * base64url). The hashed body is the text between the first blank line and
 * the next one (or the end of the message) — the full body of a simple
 * single-part message, but only the first block of a body that itself
 * contains blank lines, such as multipart output. `headers` populates the
 * `h=` tag naming the covered headers, and `now` overrides the `t=`
 * timestamp (seconds since the epoch) for deterministic output in tests.
 *
 * Note the algorithm: `a=hmac-sha256` is a symmetric-key scheme, so the
 * signature can only be checked by a party that shares the key. That suits
 * first-party verification pipelines; it is not the RSA/Ed25519 public-key
 * signing that third-party receivers expect from RFC 6376.
 *
 * ```ts no_run
 * import { renderMessage, dkimSign } from 'fino:email';
 *
 * const raw = renderMessage(message);
 * const header = await dkimSign(raw, {
 *   domain: 'example.test',
 *   selector: 's1',
 *   privateKey: sharedKey,
 *   headers: ['from', 'to', 'subject']
 * });
 * const signed = `${header}\r\n${raw}`;
 * ```
 */
export async function dkimSign(
  message: string,
  options: {
    domain: string;
    selector: string;
    privateKey: string | Uint8Array | ArrayBuffer;
    headers: string[];
    now?: number;
  },
): Promise<string> {
  const [, body = ''] = message.split(/\r\n\r\n/);
  const bh = base64urlEncode(digest('sha-256', toBytes(body)));
  const fields = `v=1; a=hmac-sha256; d=${options.domain}; s=${options.selector}; t=${options.now ?? Math.floor(Date.now() / 1000)}; h=${options.headers.join(':')}; bh=${bh}; b=`;
  const sig = base64urlEncode(hmac('sha-256', toBytes(options.privateKey), toBytes(fields)));
  return `DKIM-Signature: ${fields}${sig}`;
}

/**
 * Create a reusable DKIM signer function.
 *
 * Binds the signing options once and returns a function that signs each
 * rendered message it is given — convenient when every outbound message from
 * a domain shares the same selector and key.
 *
 * ```ts no_run
 * import { renderMessage, dkimSigner } from 'fino:email';
 *
 * const sign = dkimSigner({
 *   domain: 'example.test',
 *   selector: 's1',
 *   privateKey: sharedKey,
 *   headers: ['from', 'to', 'subject']
 * });
 *
 * const raw = renderMessage(message);
 * const header = await sign(raw);
 * ```
 */
export function dkimSigner(options: Parameters<typeof dkimSign>[1]) {
  return (message: string) => dkimSign(message, options);
}
