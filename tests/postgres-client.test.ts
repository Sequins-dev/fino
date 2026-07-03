import { describe, it } from 'fino:test/test';
import { Socket } from 'fino:net/socket';
import { PostgresDatabase, PostgresPool } from 'fino:database/postgres';
import { Database } from 'fino:database';
const enc = new TextEncoder();
const dec = new TextDecoder();
function i16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setInt16(0, value, false);
  return out;
}
function i32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, false);
  return out;
}
function cstring(value: string): Uint8Array {
  const bytes = enc.encode(value);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}
function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
function backend(tag: string, body = new Uint8Array()): Uint8Array {
  return concat([enc.encode(tag), i32(body.byteLength + 4), body]);
}
function rowDescription(name: string, oid: number): Uint8Array {
  return backend('T', concat([i16(1), cstring(name), i32(0), i16(0), i32(oid), i16(4), i32(-1), i16(0)]));
}
function dataRow(value: string): Uint8Array {
  const bytes = enc.encode(value);
  return backend('D', concat([i16(1), i32(bytes.byteLength), bytes]));
}
async function readStartup(reader: any): Promise<Record<string, string>> {
  const first = await reader.readExactly(4);
  const length = new DataView(first.buffer, first.byteOffset, 4).getInt32(0, false);
  const rest = await reader.readExactly(length - 4);
  const params: Record<string, string> = {};
  let offset = 4;
  while (offset < rest.byteLength) {
    const nameEnd = rest.indexOf(0, offset);
    if (nameEnd === offset) break;
    const name = dec.decode(rest.subarray(offset, nameEnd));
    offset = nameEnd + 1;
    const valueEnd = rest.indexOf(0, offset);
    const value = dec.decode(rest.subarray(offset, valueEnd));
    offset = valueEnd + 1;
    params[name] = value;
  }
  return params;
}
async function readClientMessage(reader: any): Promise<{ tag: string; body: Uint8Array }> {
  const head = await reader.readExactly(5);
  const tag = String.fromCharCode(head[0]);
  const length = new DataView(head.buffer, head.byteOffset + 1, 4).getInt32(0, false);
  const body = length > 4 ? await reader.readExactly(length - 4) : new Uint8Array();
  return { tag, body };
}
function queryText(body: Uint8Array): string {
  return dec.decode(body.subarray(0, body.byteLength - 1));
}
async function writeBackend(writer: any, ...messages: Uint8Array[]): Promise<void> {
  for (const message of messages) await writer.write(message);
  await writer.flush();
}
async function withFakePostgres(t: any, handler: (url: string) => Promise<void>, response: { host?: string; value?: string; command?: string; simpleQueries?: string[]; copyIn?: string[]; copyOut?: string[] } = {}): Promise<void> {
  const server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
  const done = (async () => {
    const sock = await server.accept();
    if (!sock) return;
    const [reader, writer] = sock.split();
    const params = await readStartup(reader);
    t.equal(params.user, 'ada', 'startup user passed through');
    t.equal(params.database, 'app', 'startup database passed through');
    await writeBackend(
      writer,
      backend('R', i32(0)),
      backend('K', concat([i32(99), new Uint8Array([1, 2, 3, 4])])),
      backend('S', concat([cstring('server_version'), cstring('18.0')])),
      backend('Z', enc.encode('I'))
    );
    while (true) {
      const tags: string[] = [];
      let simpleQuery = '';
      while (!tags.includes('S') && !tags.includes('X') && !tags.includes('Q')) {
        const message = await readClientMessage(reader);
        tags.push(message.tag);
        if (message.tag === 'Q') simpleQuery = queryText(message.body);
      }
      if (tags.includes('X')) break;
      if (tags.includes('Q')) {
        response.simpleQueries?.push(simpleQuery);
        if (/COPY\b/i.test(simpleQuery) && /FROM\s+STDIN/i.test(simpleQuery)) {
          await writeBackend(writer, backend('G', new Uint8Array([0, 0, 0])));
          while (true) {
            const message = await readClientMessage(reader);
            if (message.tag === 'd') response.copyIn?.push(dec.decode(message.body));
            if (message.tag === 'c') break;
            if (message.tag === 'f') throw new Error(queryText(message.body));
          }
        } else if (/COPY\b/i.test(simpleQuery) && /TO\s+STDOUT/i.test(simpleQuery)) {
          await writeBackend(
            writer,
            backend('H', new Uint8Array([0, 0, 0])),
            ...(response.copyOut ?? []).map((chunk) => backend('d', enc.encode(chunk))),
            backend('c')
          );
        }
        await writeBackend(writer, backend('C', cstring(response.command ?? 'SELECT 1')), backend('Z', enc.encode('I')));
        continue;
      }
      await writeBackend(
        writer,
        backend('1'),
        backend('2'),
        rowDescription('value', 23),
        ...(response.value !== undefined ? [dataRow(response.value)] : []),
        backend('C', cstring(response.command ?? 'SELECT 1')),
        backend('Z', enc.encode('I'))
      );
    }
    sock.close();
  })();
  let handlerError: unknown;
  try {
    const address = server.address as { port: number };
    await Promise.race([
      handler(`postgres://ada@${response.host ?? '127.0.0.1'}:${address.port}/app?sslmode=disable`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('postgres fake test timed out')), 3000))
    ]);
  } catch (err) {
    handlerError = err;
  } finally {
    server.close();
    if (handlerError) {
      done.catch(() => {});
    } else {
      await Promise.race([
        done,
        new Promise((_, reject) => setTimeout(() => reject(new Error('postgres fake server timed out')), 3000))
      ]);
    }
  }
  if (handlerError) throw handlerError;
}
describe('fino:database/postgres client', () => {
  it('opens through the concrete client and executes an extended query', async (t) => {
    await withFakePostgres(t, async (url) => {
      await using db = await PostgresDatabase.open(url);
      t.equal(db.parameters.get('server_version'), '18.0');
      const row = await db.prepare('SELECT $1::int AS value').get(42);
      t.equal(row!.value, 7);
    }, { value: '7' });
  });
  it('opens through the generic facade', async (t) => {
    await withFakePostgres(t, async (url) => {
      await using db = await Database.open(url);
      t.equal(db.driver, 'postgres');
      const row = await db.prepare('SELECT $1::int AS value').get(42);
      t.equal(row!.value, 9);
    }, { value: '9' });
  });
  it('reuses and closes idle pooled connections', async (t) => {
    await withFakePostgres(t, async (url) => {
      const pool = new PostgresPool(url, { max: 1 });
      const row = await pool.run((db) => db.prepare('SELECT 1 AS value').get());
      t.equal(row!.value, 5);
      await pool.close();
    }, { value: '5' });
  });
  it('resolves hostnames before connecting sockets', async (t) => {
    await withFakePostgres(t, async (url) => {
      await using db = await PostgresDatabase.open(url);
      const row = await db.prepare('SELECT $1::int AS value').get(42);
      t.equal(row!.value, 11);
    }, { host: 'localhost', value: '11' });
  });
  it('quotes LISTEN and NOTIFY channel names and payloads', async (t) => {
    const simpleQueries: string[] = [];
    await withFakePostgres(t, async (url) => {
      await using db = await PostgresDatabase.open(url);
      await db.listen('with "quotes"');
      await db.notify('with "quotes"', "payload 'quoted'");
    }, { simpleQueries });
    t.deepEqual(simpleQueries, ['LISTEN "with ""quotes"""', 'NOTIFY "with ""quotes""", \'payload \'\'quoted\'\'\'']);
  });
  it('streams COPY FROM STDIN chunks and collects COPY TO STDOUT chunks', async (t) => {
    const simpleQueries: string[] = [];
    const copyIn: string[] = [];
    await withFakePostgres(t, async (url) => {
      await using db = await PostgresDatabase.open(url);
      const result = await db.copyFrom('COPY t FROM STDIN', ['a\t1\n', enc.encode('b\t2\n')]);
      const chunks = await db.copyTo('COPY t TO STDOUT');
      t.equal(result.command, 'COPY 2');
      t.deepEqual(chunks.map((chunk) => dec.decode(chunk)), ['x\t3\n', 'y\t4\n']);
    }, { command: 'COPY 2', simpleQueries, copyIn, copyOut: ['x\t3\n', 'y\t4\n'] });
    t.deepEqual(simpleQueries, ['COPY t FROM STDIN', 'COPY t TO STDOUT']);
    t.deepEqual(copyIn, ['a\t1\n', 'b\t2\n']);
  });
  it('queues pool waiters when max connections are checked out', async (t) => {
    await withFakePostgres(t, async (url) => {
      const pool = new PostgresPool(url, { max: 1 });
      const db = await pool.connect();
      let resolved = false;
      const next = pool.connect().then((nextDb) => {
        resolved = true;
        return nextDb;
      });
      await Promise.resolve();
      t.equal(resolved, false);
      pool.release(db);
      const db2 = await next;
      t.equal(db2, db);
      pool.release(db2);
      await pool.close();
    });
  });
});
