const sab = new SharedArrayBuffer(4);
const view = new Int32Array(sab);

const waiter = Atomics.waitAsync(view, 0, 0);
setTimeout(() => {
  Atomics.store(view, 0, 1);
  Atomics.notify(view, 0, 1);
}, 20);

const result = await waiter.value;
console.log(`waitAsync:${result}:${Atomics.load(view, 0)}`);
