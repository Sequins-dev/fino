/**
* fino:email - transactional email messages, SMTP delivery, and DKIM signing.
*
* Useful references:
* - SMTP: https://www.rfc-editor.org/rfc/rfc5321
* - Internet message format: https://www.rfc-editor.org/rfc/rfc5322
* - STARTTLS for SMTP: https://www.rfc-editor.org/rfc/rfc3207
* - SMTP AUTH: https://www.rfc-editor.org/rfc/rfc4954
* - DKIM: https://www.rfc-editor.org/rfc/rfc6376
*
* The v1 surface provides MIME rendering, a small SMTP client, a provider
* transport interface, and DKIM signing. Hosted provider adapters are expected
* to live in external packages that implement `EmailTransport`.
*/
import { hmac, digest } from './internal/openssl.ts';
import { base64urlEncode, toBytes } from './internal/security/encoding.ts';

export type EmailAddress = string;

export interface EmailMessage {
  from: EmailAddress;
  to: EmailAddress | EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  date?: Date;
  messageId?: string;
  boundary?: string;
  attachments?: EmailAttachment[];
}

/** Attachment rendered into a MIME message. */
export interface EmailAttachment {
  filename: string;
  contentType?: string;
  content: string | Uint8Array;
}

export interface EmailSendResult {
  id?: string;
  accepted?: string[];
  rejected?: string[];
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<EmailSendResult> | EmailSendResult;
}

function assertHeader(value: string): void {
  if (/[\r\n]/.test(value)) throw new Error('Invalid email header value');
}

function list(value: EmailAddress | EmailAddress[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/** Render an email message as RFC 5322/MIME text. */
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
    'MIME-Version: 1.0'
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
    const parts = [`--${boundary}\r\n${message.html !== undefined && message.text !== undefined ? `Content-Type: multipart/alternative; boundary="${boundary}-alt"\r\n\r\n${body}` : body}`];
    for (const attachment of message.attachments ?? []) {
      assertHeader(attachment.filename);
      const content = typeof attachment.content === 'string' ? attachment.content : btoa(String.fromCharCode(...attachment.content));
      parts.push(`--${boundary}\r\nContent-Type: ${attachment.contentType ?? 'application/octet-stream'}\r\nContent-Disposition: attachment; filename="${attachment.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${content}\r\n`);
    }
    parts.push(`--${boundary}--\r\n`);
    return headers.join('\r\n') + '\r\n\r\n' + parts.join('');
  }
  return headers.join('\r\n') + '\r\n' + body;
}

/** Send a message through an injected SMTP or provider transport. */
export async function send(message: EmailMessage, options: { transport: EmailTransport }): Promise<EmailSendResult> {
  return await options.transport.send(message);
}

function b64(value: string): string {
  return btoa(value);
}

function dotStuff(data: string): string {
  return data.replace(/\r?\n/g, '\r\n').split('\r\n').map((line) => line.startsWith('.') ? `.${line}` : line).join('\r\n');
}

export class SmtpClient implements EmailTransport {
  #reader: string[];
  #writer: { write(chunk: string): void | Promise<void> };
  constructor(connection: { reader: string[]; writer: { write(chunk: string): void | Promise<void> } }) {
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
  /** Send one message through the SMTP transaction. */
  async send(message: EmailMessage, options: { username?: string; password?: string } = {}): Promise<EmailSendResult> {
    await this.#read(220);
    await this.#write('EHLO localhost\r\n');
    await this.#read(250);
    if (options.username !== undefined || options.password !== undefined) {
      await this.#write(`AUTH PLAIN ${b64(`\0${options.username ?? ''}\0${options.password ?? ''}`)}\r\n`);
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

/** Use an `SmtpClient` wherever an `EmailTransport` is accepted. */
export function smtpTransport(client: SmtpClient): EmailTransport {
  return client;
}

/** Create a DKIM-Signature header for a rendered message. */
export async function dkimSign(message: string, options: { domain: string; selector: string; privateKey: string | Uint8Array | ArrayBuffer; headers: string[]; now?: number }): Promise<string> {
  const [, body = ''] = message.split(/\r\n\r\n/);
  const bh = base64urlEncode(digest('sha-256', toBytes(body)));
  const fields = `v=1; a=hmac-sha256; d=${options.domain}; s=${options.selector}; t=${options.now ?? Math.floor(Date.now() / 1000)}; h=${options.headers.join(':')}; bh=${bh}; b=`;
  const sig = base64urlEncode(hmac('sha-256', toBytes(options.privateKey), toBytes(fields)));
  return `DKIM-Signature: ${fields}${sig}`;
}

/** Create a reusable DKIM signer function. */
export function dkimSigner(options: Parameters<typeof dkimSign>[1]) {
  return (message: string) => dkimSign(message, options);
}
