/** Reports every nondeterministic primitive the realm exposes. */
export default async function probe(longDelayMs: number = 86_400_000): Promise<{
  dateNow: number;
  dateCtor: number;
  perfOrigin: number;
  randoms: number[];
  uuid: string;
  cryptoBytes: number[];
  aesKey: number[];
  unseededCryptoRejected: boolean;
  longTimerElapsed: number;
  timerOrder: string[];
}> {
  const dateNow = Date.now();
  const dateCtor = new Date().getTime();
  const perfOrigin = performance.timeOrigin;
  const randoms = [Math.random(), Math.random(), Math.random()];
  const uuid = crypto.randomUUID();
  const cryptoBytes = [...crypto.getRandomValues(new Uint8Array(8))];
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt']);
  const aesKey = [...new Uint8Array(await crypto.subtle.exportKey('raw', key))];
  let unseededCryptoRejected = false;
  try {
    await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
  } catch (error) {
    unseededCryptoRejected = String(error).includes('entropy that cannot be seeded');
  }
  const timerOrder: string[] = [];
  const start = Date.now();
  await new Promise<void>((resolve) => {
    setTimeout(() => timerOrder.push('c-300'), 300);
    setTimeout(() => timerOrder.push('a-100'), 100);
    setTimeout(() => timerOrder.push('b-200'), 200);
    // A full day by default: instant under virtual time, unrunnable under a
    // real clock, so a non-simulated caller passes something short instead.
    setTimeout(() => {
      timerOrder.push('day');
      resolve();
    }, longDelayMs);
  });
  return {
    dateNow,
    dateCtor,
    perfOrigin,
    randoms,
    uuid,
    cryptoBytes,
    aesKey,
    unseededCryptoRejected,
    longTimerElapsed: Date.now() - start,
    timerOrder,
  };
}
