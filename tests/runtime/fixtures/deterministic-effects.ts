export default async function observeDeterministicEffects() {
  const before = {
    date: Date.now(),
    constructedDate: new Date().getTime(),
    performance: performance.now(),
    timeOrigin: performance.timeOrigin,
    random: Math.random(),
    bytes: [...crypto.getRandomValues(new Uint8Array(8))],
  };
  for (let timer = 0; timer < 25; timer++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return {
    before,
    after: {
      date: Date.now(),
      performance: performance.now(),
      random: Math.random(),
      bytes: [...crypto.getRandomValues(new Uint8Array(8))],
    },
  };
}
