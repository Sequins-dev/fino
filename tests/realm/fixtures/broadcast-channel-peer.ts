/**
 * Realm fixture — bridge BroadcastChannel messages through realmPort.
 */
const port = (globalThis as any).realmPort as MessagePort | undefined;
if (!port) {
  throw new Error('broadcast-channel-peer: expected a realmPort');
}
let channel: BroadcastChannel | null = null;
port.onmessage = (ev) => {
  const msg = ev.data as {
    type: string;
    name?: string;
    data?: unknown;
  };
  if (msg.type === 'listen') {
    channel?.close();
    channel = new BroadcastChannel(String(msg.name));
    channel.onmessage = (event) => {
      port.postMessage({
        type: 'broadcast',
        data: event.data,
      });
    };
    port.postMessage({ type: 'ready' });
  } else if (msg.type === 'broadcast') {
    channel?.postMessage(msg.data);
  } else if (msg.type === 'close') {
    channel?.close();
    channel = null;
    port.postMessage({ type: 'closed' });
  }
};
await new Promise<void>(() => {});
