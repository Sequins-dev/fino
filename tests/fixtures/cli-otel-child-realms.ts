import { Realm } from 'fino:realm';

globalThis.fetch = async function childRealmParentFetch(url) {
  console.log(`parent-export:${String(url)}`);
  return new Response('{}', { status: 200 });
};

const entry = new URL('./cli-otel-realm-child.ts', import.meta.url).pathname;

async function runChild(realm: Realm): Promise<void> {
  console.log('child:start');
  const done = new Promise<void>((resolve) => {
    realm.port.onmessage = (ev) => {
      if ((ev as MessageEvent).data?.type === 'done') resolve();
    };
    realm.port.start();
  });
  const running = realm.run();
  await Promise.race([
    done,
    running.then(() => {
      throw new Error('child exited before posting done');
    }),
  ]);
  console.log('child:message');
  realm.terminate();
  // The next marker owns a new child; wait for this child's shutdown exports
  // instead of classifying late exports as traffic from the next child.
  await running;
}

await runChild(new Realm({ entry, data: { label: 'inherited' } }));
console.log('child:inherited:done');

await runChild(
  new Realm({
    entry,
    otlpEndpoint: 'http://override-collector.example:4318/override',
    data: { label: 'override' },
  }),
);
console.log('child:override:done');

await runChild(
  new Realm({
    entry,
    otlpEndpoint: false,
    data: { label: 'disabled' },
  }),
);
console.log('child:disabled:done');
