import { chunks, fast, upload } from 'app:cassette';

export default async function (variant = 'same') {
  const value = await fast({ variant, nested: new Set([1n, 2n]) });
  const streamed: unknown[] = [];
  for await (const chunk of chunks(`prefix:${variant}`)) streamed.push(chunk);
  const sink = upload(`target:${variant}`);
  sink.write('one');
  sink.write({ two: 2 });
  sink.close();
  return { value, streamed, uploaded: await sink.result };
}
