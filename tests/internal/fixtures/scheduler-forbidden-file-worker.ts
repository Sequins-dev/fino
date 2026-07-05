// A scheduler-managed tenant may not acquire raw FFI: `fino:ffi` is blocked, so
// the only path to the filesystem is the scheduler-backed `fino:file` provider.
// This import must fail, failing the workload.
import { dlopen } from 'fino:ffi';

export default async function schedulerForbiddenFfiWorker(): Promise<{
  result: 'idle';
}> {
  void dlopen;
  return {
    result: 'idle'
  };
}
