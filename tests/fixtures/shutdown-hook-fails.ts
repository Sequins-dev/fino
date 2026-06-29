import { registerShutdownHook } from 'internal:shutdown';
registerShutdownHook(() => {
  throw new Error('shutdown hook failed');
});
console.log('script completed');
