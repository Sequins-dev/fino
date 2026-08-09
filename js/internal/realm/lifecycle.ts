/**
 * internal:realm/lifecycle — a realm's own view of being asked to stop.
 *
 * Termination is a control frame, not application data: it arrives in the
 * envelope header, where a realm cannot forge one for itself. That is the right
 * place for it, but it left long-running entry modules with no way to hear it.
 * A realm whose work is a repeating timer stays alive as long as it keeps
 * re-arming, and the loop only exits once the realm is done *and* holds no live
 * handles — so such a realm ignored `terminate()` entirely once the request
 * stopped being visible as a message on the payload.
 *
 * This is the replacement for reading `__terminate` off a cloned object: the
 * bootstrap observes the header and announces it here, and an entry module asks
 * to be told rather than inspecting traffic it should not have to interpret.
 *
 * @internal
 */

const listeners = new Set<() => void>();
let requested = false;

/**
 * Register a listener for the parent's termination request.
 *
 * Fires at most once, and fires immediately if the request already arrived —
 * an entry module that registers late must not miss it, since the window
 * between the port starting and the module finishing evaluation is exactly
 * when an eager `terminate()` lands.
 *
 * Returns an unsubscribe function.
 */
export function onTerminate(listener: () => void): () => void {
  if (requested) {
    listener();
    return () => {};
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the parent has asked this realm to stop. */
export function terminateRequested(): boolean {
  return requested;
}

/**
 * Announce that the parent asked this realm to stop. Called by the realm
 * bootstrap when it decodes a `Terminate` envelope.
 *
 * @internal
 */
export function signalTerminate(): void {
  if (requested) return;
  requested = true;
  for (const listener of listeners) {
    // One listener's failure must not strand the others: this runs on the path
    // that stops the realm, and a half-delivered signal is a realm that never
    // exits.
    try {
      listener();
    } catch {}
  }
  listeners.clear();
}
