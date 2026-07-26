/**
 * internal:scheduler/reactor — main-realm process readiness coordination.
 *
 * The main TypeScript realm owns the process io_uring/kqueue backend. Workload
 * realms send it scalar readiness registrations through a native mailbox. This
 * module installs those watches on the ordinary TypeScript loop and routes
 * scalar completions back to their owning workload. Actual reads, writes,
 * buffers, retries, and protocol policy stay inside the workload realm.
 *
 * @internal
 */
import * as loop from 'internal:runtime/loop';
import * as backend from 'internal:runtime/loop-backend';
import { routeProcessReadiness, takeSharedReadinessChanges } from 'internal:scheduler-native';

interface ReadinessChange {
  ident: number;
  filter: number;
  flags: number;
  fflags: number;
  data: number;
  udata: number;
  cancelOwner?: number;
}

const EVFILT_READ = -1;
const EVFILT_WRITE = -2;
const EVFILT_TIMER = backend.EVFILT_TIMER;
const EV_DELETE = 2;
const TOKEN_BASE = 4294967296;

interface Registration {
  generation: number;
  owner: number;
  change: ReadinessChange;
  cancel(): void;
}

/**
 * Install process-workload readiness watches on the caller's TypeScript loop.
 *
 * The controller is deliberately policy-free. It reports owner-tagged
 * completions and mailbox wakes to its caller, which owns workload priority and
 * placement. `stop()` unregisters the native mailbox descriptor and every
 * outstanding workload watch.
 *
 * @internal
 */
export class ProcessReadinessController {
  #registrations = new Map<string, Registration>();
  #readyListeners = new Map<number, () => void>();
  #running = false;
  constructor(readonly controlFd: number) {}
  #key(change: ReadinessChange): string {
    return `${change.filter}:${change.ident}`;
  }
  #apply(change: ReadinessChange): void {
    if (change.cancelOwner !== undefined) {
      for (const [registration, active] of this.#registrations) {
        if (active.owner !== change.cancelOwner) continue;
        this.#registrations.delete(registration);
        active.cancel();
      }
      return;
    }
    const registration = this.#key(change);
    const previous = this.#registrations.get(registration);
    const generation = (previous?.generation ?? 0) + 1;
    const owner = Math.floor(change.udata / TOKEN_BASE);
    previous?.cancel();
    this.#registrations.delete(registration);
    if ((change.flags & EV_DELETE) !== 0) return;
    let cancel: () => void;
    let ready: Promise<number | void>;
    if (change.filter === EVFILT_READ) {
      ready = loop.readable(change.ident);
      cancel = () => loop.removeRead(change.ident);
    } else if (change.filter === EVFILT_WRITE) {
      ready = loop.writable(change.ident);
      cancel = () => loop.removeWrite(change.ident);
    } else if (change.filter === EVFILT_TIMER) {
      const timer = loop.timeout(change.data);
      ready = timer;
      cancel = () => timer.cancel();
    } else {
      throw new Error(`unsupported process readiness filter: ${change.filter}`);
    }
    this.#registrations.set(registration, {
      generation,
      owner,
      change,
      cancel,
    });
    void ready.then((available) => {
      if (this.#registrations.get(registration)?.generation !== generation) return;
      this.#registrations.delete(registration);
      routeProcessReadiness(
        owner,
        change.ident,
        change.filter,
        0,
        0,
        typeof available === 'number' ? available : 0,
        change.udata,
        !this.#readyListeners.has(owner),
      );
      this.#readyListeners.get(owner)?.();
    });
  }
  #drainCommands(): void {
    const changes = JSON.parse(takeSharedReadinessChanges()) as ReadinessChange[];
    for (const change of changes) this.#apply(change);
  }
  /** Drain queued registrations and begin watching the native mailbox. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#drainCommands();
    loop.registerWakeSource(this.controlFd, () => this.#drainCommands());
  }
  /** Route an owner's completions directly when its scheduler is this realm. */
  listen(owner: number, ready: () => void): () => void {
    this.#readyListeners.set(owner, ready);
    return () => {
      if (this.#readyListeners.get(owner) === ready) this.#readyListeners.delete(owner);
    };
  }
  /** Remove all process-workload and mailbox readiness watches. */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    loop.unregisterWakeSource(this.controlFd);
    for (const active of this.#registrations.values()) active.cancel();
    this.#registrations.clear();
    this.#readyListeners.clear();
  }
}

let processController: ProcessReadinessController | undefined;

/** Install the one controller owned by the process main TypeScript realm. */
export function installProcessReadinessController(controller: ProcessReadinessController): void {
  processController = controller;
}

/** Return the controller only when called from its main TypeScript realm. */
export function currentProcessReadinessController(): ProcessReadinessController | undefined {
  return processController;
}
