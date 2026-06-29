import { registerShutdownHook } from 'internal:shutdown';
registerShutdownHook(() => {
  throw new Error('secondary shutdown failure');
});
throw new Error('primary script failure');
