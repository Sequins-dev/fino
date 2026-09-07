/** Probe ambient capabilities that would bypass simulation Facades and journals. */

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function construct(name: string, create: () => { close(): unknown }): string {
  try {
    const resource = create();
    resource.close();
    return `${name} reached the host`;
  } catch (error) {
    return message(error);
  }
}

export default async function probe(): Promise<Record<string, string>> {
  let fetchResult: string;
  try {
    await fetch('http://127.0.0.1:45999/');
    fetchResult = 'fetch reached the host';
  } catch (error) {
    fetchResult = message(error);
  }

  const webTransport = construct('WebTransport', () => {
    const transport = new WebTransport('https://127.0.0.1:45999/');
    void transport.ready.catch(() => {});
    void transport.closed.catch(() => {});
    void transport.draining.catch(() => {});
    return transport;
  });

  return {
    fetch: fetchResult,
    WebSocket: construct('WebSocket', () => new WebSocket('ws://127.0.0.1:45999/')),
    WebTransport: webTransport,
    EventSource: construct('EventSource', () => new EventSource('http://127.0.0.1:45999/')),
    BroadcastChannel: construct('BroadcastChannel', () => new BroadcastChannel('sim-probe')),
    SharedArrayBuffer: (() => {
      try {
        new SharedArrayBuffer(64);
        return 'SharedArrayBuffer allocated host-visible memory';
      } catch (error) {
        return message(error);
      }
    })(),
  };
}
