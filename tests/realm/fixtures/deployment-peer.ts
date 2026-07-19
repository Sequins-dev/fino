const id = Math.random();
const messages: unknown[] = [];

(globalThis as { realmPort?: MessagePort }).realmPort?.addEventListener('message', (event) => {
  const message = (event as MessageEvent).data;
  if (!message || typeof message !== 'object' || (message as { __call?: boolean }).__call !== true) {
    messages.push(message);
  }
});

export default function deploymentPeer(): { id: number; messages: unknown[] } {
  return { id, messages: [...messages] };
}
