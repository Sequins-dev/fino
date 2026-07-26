import { describe, it } from 'fino:test/test';
import { SmtpClient, dkimSign, renderMessage, send } from 'fino:email';

describe('fino:email', () => {
  it('renders MIME messages and rejects header injection', (t) => {
    const rendered = renderMessage({
      from: 'Ada <ada@example.test>',
      to: ['ops@example.test'],
      subject: 'Hello',
      text: 'line one',
      html: '<p>line one</p>',
      date: new Date('2020-01-02T03:04:05Z'),
      messageId: '<m1@example.test>',
      boundary: 'b-test',
    });
    t.ok(rendered.includes('Subject: Hello'), 'subject is rendered');
    t.ok(
      rendered.includes('multipart/alternative; boundary="b-test-alt"'),
      'alternative multipart is rendered',
    );
    t.ok(rendered.includes('<p>line one</p>'), 'html body is rendered');
    t.throws(
      () =>
        renderMessage({
          from: 'a@example.test',
          to: 'b@example.test',
          subject: 'bad\r\nBcc: x@example.test',
          text: 'x',
        }),
      /header/i,
    );
  });

  it('sends through provider transports', async (t) => {
    let sawSubject = false;
    const result = await send(
      {
        from: 'a@example.test',
        to: 'b@example.test',
        subject: 'Provider',
        text: 'hello',
      },
      {
        transport: {
          async send(message) {
            sawSubject = message.subject === 'Provider';
            return { id: 'provider-1' };
          },
        },
      },
    );
    t.equal(sawSubject, true);
    t.equal(result.id, 'provider-1');
  });

  it('runs SMTP commands with dot-stuffed DATA', async (t) => {
    const writes: string[] = [];
    const client = new SmtpClient({
      reader: [
        '220 mx.example.test ESMTP\r\n',
        '250-mx.example.test\r\n250-AUTH PLAIN LOGIN\r\n250 STARTTLS\r\n',
        '235 ok\r\n',
        '250 sender ok\r\n',
        '250 recipient ok\r\n',
        '354 go\r\n',
        '250 queued\r\n',
        '221 bye\r\n',
      ],
      writer: { write: (chunk: string) => writes.push(chunk) },
    });
    const result = await client.send(
      {
        from: 'a@example.test',
        to: 'b@example.test',
        subject: 'SMTP',
        text: '.leading dot',
      },
      { username: 'u', password: 'p' },
    );
    t.equal(result.accepted.length, 1);
    const transcript = writes.join('');
    t.ok(transcript.includes('..leading dot'), 'DATA body is dot-stuffed');
    t.ok(transcript.includes('\r\n.\r\n'), 'DATA is terminated');
  });

  it('creates DKIM signatures', async (t) => {
    const header = await dkimSign('From: a@example.test\r\nSubject: Test\r\n\r\nhello\r\n', {
      domain: 'example.test',
      selector: 's1',
      privateKey: 'secret',
      headers: ['from', 'subject'],
      now: 123,
    });
    t.ok(
      header.startsWith('DKIM-Signature: v=1; a=hmac-sha256; d=example.test; s=s1;'),
      'DKIM header is rendered',
    );
    t.ok(header.includes('bh='), 'body hash is present');
    t.ok(header.includes('b='), 'signature is present');
  });
});
