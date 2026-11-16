import { startProfiling, stopProfiling } from 'fino:profiler';
import { pprofFunctionSampleCounts } from './pprof.ts';

function beforeMove() {
  const end = Date.now() + 100;
  while (Date.now() < end) Math.sqrt(Date.now());
}
function afterMove() {
  const end = Date.now() + 100;
  while (Date.now() < end) Math.sqrt(Date.now());
}
startProfiling('migration');
beforeMove();
function checkMigrationProfile(bytes: Uint8Array) {
  const counts = pprofFunctionSampleCounts(bytes);
  if ((counts.get('beforeMove') ?? 0) < 5 || (counts.get('afterMove') ?? 0) < 5) {
    throw new Error(`profile lost samples across thread migration: ${JSON.stringify([...counts])}`);
  }
}
(globalThis as any).checkMigrationProfile = checkMigrationProfile;
(globalThis as any).finishMigrationProbe = () => {
  afterMove();
  checkMigrationProfile(stopProfiling('migration'));
};
await new Promise(() => {});
