import { describe, it } from 'fino:test/test';
import { Database } from 'fino:database/sqlite';
import { RecordBatch, tableToIPC } from 'fino:data/arrow';
import { writeParquet } from 'fino:data/parquet';
import {
  DataLoader,
  Dataset,
  IterableDataset,
  arrowCollator,
  arrowDataset,
  csvDataset,
  hubDataset,
  httpDataset,
  jsonlDataset,
  parquetDataset,
  sqliteDataset,
} from 'fino:data/dataset';

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

describe('Dataset and IterableDataset', () => {
  it('provides deterministic random access and lazy transforms', async (t) => {
    const source = Dataset.from([1, 2, 3, 4, 5]);

    t.equal(source.length, 5);
    t.equal(await source.get(2), 3);
    t.deepEqual(
      await collect(
        source
          .map((value) => value * 2)
          .filter((value) => value > 4)
          .take(2),
      ),
      [6, 8],
    );
    t.deepEqual(await collect(source.batch(2)), [[1, 2], [3, 4], [5]]);
  });

  it('closes upstream iterators after take and cancellation', async (t) => {
    let pulls = 0;
    let closed = 0;
    const source = new IterableDataset<number>(async function* () {
      try {
        for (let value = 0; value < 10; value++) {
          pulls++;
          yield value;
        }
      } finally {
        closed++;
      }
    });

    t.deepEqual(await collect(source.take(2)), [0, 1]);
    t.equal(pulls, 2, 'pull-based iteration does not read ahead');
    t.equal(closed, 1, 'take closes its upstream iterator');

    const controller = new AbortController();
    const iterator = source.iterate({ signal: controller.signal });
    t.deepEqual(await iterator.next(), { done: false, value: 0 });
    controller.abort();
    await t.rejects(() => iterator.next(), /aborted/i);
    t.equal(closed, 2, 'cancellation closes its upstream iterator');
  });

  it('derives repeatable shuffle and split order from seed, epoch, and worker', async (t) => {
    const source = Dataset.from(Array.from({ length: 20 }, (_, index) => index));
    const shuffled = source.shuffle({ bufferSize: 5, seed: 42 });

    const first = await collect(shuffled.iterate({ epoch: 3, workerId: 1 }));
    const second = await collect(shuffled.iterate({ epoch: 3, workerId: 1 }));
    const nextEpoch = await collect(shuffled.iterate({ epoch: 4, workerId: 1 }));

    t.deepEqual(first, second, 'same seed context produces the same order');
    t.notEqual(
      JSON.stringify(first),
      JSON.stringify(nextEpoch),
      'epoch contributes to the random stream',
    );
    t.deepEqual(
      [...first].sort((a, b) => a - b),
      source.toArray(),
    );

    const [train, validation] = source.split([3, 1], { seed: 7 });
    const trainRows = await collect(train!);
    const validationRows = await collect(validation!);
    t.deepEqual(
      [...trainRows, ...validationRows].sort((a, b) => a - b),
      source.toArray(),
      'splits neither duplicate nor omit values',
    );
  });

  it('interleaves finite and streaming inputs without pre-reading either', async (t) => {
    const numbers = Dataset.from([1, 2, 3]);
    const letters = IterableDataset.from(['a', 'b']);

    t.deepEqual(await collect(numbers.interleave(letters)), [1, 'a', 2, 'b', 3]);

    const contextual = Dataset.from(['value']).map((_, context) => context.epoch);
    t.deepEqual(
      await collect(Dataset.from<number>([]).interleave(contextual).iterate({ epoch: 7 })),
      [7],
      'both dataset inputs receive the same iteration context',
    );
  });

  it('rejects invalid indexing, batching, shuffling, and split weights', async (t) => {
    const source = Dataset.from([1, 2, 3]);
    await t.rejects(() => source.get(3), /out of range/i);
    t.throws(() => source.batch(0), /size/i);
    t.throws(() => source.shuffle({ bufferSize: 0 }), /bufferSize/i);
    t.throws(() => source.split([]), /at least one weight/i);
    t.throws(() => source.split([1, 0]), /positive/i);
  });
});

describe('DataLoader', () => {
  it('batches lazily and applies custom and Arrow collators', async (t) => {
    const source = Dataset.from([
      { id: 1, text: 'one' },
      { id: 2, text: 'two' },
      { id: 3, text: 'three' },
    ]);
    const ids = new DataLoader(source, {
      batchSize: 2,
      collate: (rows) => rows.map((row) => row.id),
    });

    t.deepEqual(await collect(ids), [[1, 2], [3]]);

    const arrow = new DataLoader(source, {
      batchSize: 2,
      dropLast: true,
      collate: arrowCollator,
    });
    const batches = await collect(arrow);
    t.equal(batches.length, 1);
    t.equal(batches[0]!.numRows, 2);
    t.deepEqual(batches[0]!.getChild('text')!.toArray(), ['one', 'two']);
  });

  it('makes loader shuffle explicit and repeatable per epoch', async (t) => {
    const loader = new DataLoader(Dataset.from([0, 1, 2, 3, 4, 5]), {
      batchSize: 2,
      shuffle: { bufferSize: 3 },
      seed: 99,
    });

    t.deepEqual(await collect(loader.forEpoch(2)), await collect(loader.forEpoch(2)));
    t.notEqual(
      JSON.stringify(await collect(loader.forEpoch(2))),
      JSON.stringify(await collect(loader.forEpoch(3))),
    );
  });
});

describe('dataset sources', () => {
  it('streams CSV and JSONL records', async (t) => {
    const csv = csvDataset('name,age\nAda,36\nGrace,85\n', {
      header: true,
      cast: true,
    });
    t.deepEqual(await collect(csv), [
      { name: 'Ada', age: 36 },
      { name: 'Grace', age: 85 },
    ]);

    const chunks = [new TextEncoder().encode('{"id":1}\n{"id":'), new TextEncoder().encode('2}\n')];
    t.deepEqual(await collect(jsonlDataset(IterableDataset.from(chunks))), [{ id: 1 }, { id: 2 }]);
  });

  it('streams Arrow IPC and Parquet as record batches', async (t) => {
    const batch = RecordBatch.from({ id: [1, 2], name: ['a', 'b'] });

    const arrowBatches = await collect(arrowDataset(tableToIPC(batch)));
    t.equal(arrowBatches.length, 1);
    t.deepEqual(arrowBatches[0]!.toArray(), batch.toArray());

    const parquetBatches = await collect(parquetDataset(writeParquet(batch)));
    t.equal(parquetBatches.length, 1);
    t.deepEqual(parquetBatches[0]!.toArray(), batch.toArray());
  });

  it('streams SQLite statements and decodes HTTP and hub-compatible responses', async (t) => {
    const db = await Database.open(':memory:', { safeIntegers: false });
    await db.exec('CREATE TABLE items (id INTEGER, name TEXT)');
    await db.exec("INSERT INTO items VALUES (1, 'one'), (2, 'two')");

    t.deepEqual(await collect(sqliteDataset(db, 'SELECT * FROM items ORDER BY id')), [
      { id: 1, name: 'one' },
      { id: 2, name: 'two' },
    ]);

    const requests: Request[] = [];
    const remote = httpDataset<{ id: number }>('https://hub.example/data.jsonl', {
      format: 'jsonl',
      headers: { authorization: 'Bearer secret' },
      fetch: async (request) => {
        requests.push(request);
        return new Response('{"id":1}\n{"id":2}\n');
      },
    });
    t.deepEqual(await collect(remote), [{ id: 1 }, { id: 2 }]);
    t.equal(requests[0]!.headers.get('authorization'), 'Bearer secret');

    const hub = hubDataset<{ id: number }>('org/corpus', 'train/data.jsonl', {
      format: 'jsonl',
      baseUrl: 'https://hub.example/datasets',
      revision: 'v1',
      token: 'hub-token',
      fetch: async (request) => {
        requests.push(request);
        return new Response('{"id":3}\n');
      },
    });
    t.deepEqual(await collect(hub), [{ id: 3 }]);
    t.equal(
      requests[1]!.url,
      'https://hub.example/datasets/org/corpus/resolve/v1/train/data.jsonl',
    );
    t.equal(requests[1]!.headers.get('authorization'), 'Bearer hub-token');
    await db.close();
  });

  it('cancels an HTTP response body when iteration stops early', async (t) => {
    let canceled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":1}\n{"id":2}\n'));
      },
      cancel() {
        canceled++;
      },
    });
    const remote = httpDataset<{ id: number }>('https://example.test/data.jsonl', {
      format: 'jsonl',
      fetch: async () => new Response(body),
    });

    t.deepEqual(await collect(remote.take(1)), [{ id: 1 }]);
    t.equal(canceled, 1, 'early return cancels the unread response body');
  });

  it('reports non-success HTTP responses before decoding', async (t) => {
    const remote = httpDataset('https://example.test/missing.json', {
      format: 'json',
      fetch: async () => new Response('missing', { status: 404, statusText: 'Not Found' }),
    });
    await t.rejects(() => collect(remote), /404 Not Found/);
  });
});
