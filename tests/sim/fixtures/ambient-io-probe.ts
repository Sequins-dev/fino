/** Probe every ambient network path a simulation closes or virtualizes. */
export default async function probe(): Promise<string[]> {
  const reached: string[] = [];
  try {
    await fetch('http://127.0.0.1:45999/');
    reached.push('fetch');
  } catch {}
  for (const [name, construct] of [
    ['WebSocket', () => new WebSocket('ws://127.0.0.1:45999/')],
    ['WebTransport', () => new WebTransport('https://127.0.0.1:45999/')],
    ['EventSource', () => new EventSource('http://127.0.0.1:45999/')],
    ['BroadcastChannel', () => new BroadcastChannel('probe')],
  ] as const) {
    try {
      construct();
      reached.push(name);
    } catch {}
  }
  return reached;
}
