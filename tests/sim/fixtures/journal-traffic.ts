import { chunks, fast, mutate, slow, upload } from 'app:journal';

export default async function () {
  const calls = await Promise.all([slow('first'), fast('second')]);
  const input = { state: 'before' };
  await mutate(input);
  const streamed: unknown[] = [];
  for await (const chunk of chunks()) streamed.push(chunk);
  const sink = upload('target');
  sink.write('one');
  sink.write({ two: 2 });
  sink.close();
  return { calls, input, streamed, uploaded: await sink.result };
}
