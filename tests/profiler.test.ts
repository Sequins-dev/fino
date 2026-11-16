import { test } from 'fino:test/test';
import { startProfiling, stopProfiling } from 'fino:profiler';
import { pprofFunctionSampleCounts } from './fixtures/pprof.ts';
test('profiling retains samples across reactor yields', async (t) => {
  startProfiling('yielding');
  function beforeYield() {
    const end = Date.now() + 100;
    while (Date.now() < end) Math.sqrt(Date.now());
  }
  beforeYield();
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    const phase = new Function(`return function afterYield${i}() {
      const end = Date.now() + 100;
      while (Date.now() < end) Math.sqrt(Date.now());
    }`)();
    phase();
  }
  const samples = pprofFunctionSampleCounts(stopProfiling('yielding'));
  t.ok((samples.get('beforeYield') ?? 0) >= 5, 'samples the initial execution slice');
  for (let i = 0; i < 8; i++) {
    t.ok((samples.get(`afterYield${i}`) ?? 0) >= 5, `samples rescheduled slice ${i}`);
  }
});
test('startProfiling and stopProfiling return pprof bytes', (t) => {
  startProfiling('test');
  let sum = 0;
  for (let i = 0; i < 1e6; i++) sum += i;
  const bytes = stopProfiling('test');
  t.ok(bytes instanceof Uint8Array, 'returns Uint8Array');
  t.ok(bytes.byteLength > 0, 'non-empty pprof output');
  // pprof field 1 (sample_type) tag = (1 << 3) | 2 = 0x0a
  t.equal(bytes[0], 10, 'starts with sample_type field tag');
  t.ok(sum > 0, 'computation ran');
});
test('stopProfiling without start throws', (t) => {
  t.throws(
    () => stopProfiling('nonexistent'),
    /no matching profile|no profiler/,
    'throws on missing profile',
  );
});
test('profiling with no title argument works', (t) => {
  startProfiling();
  const bytes = stopProfiling();
  t.ok(bytes instanceof Uint8Array, 'no-title profiling works');
  t.ok(bytes.byteLength > 0, 'non-empty output');
});
