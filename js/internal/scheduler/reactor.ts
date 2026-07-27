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
import { serialize } from 'internal:serializer';
import {
  acknowledgeProcessReadiness,
  routeProcessReadiness,
  signalReactorOwner,
  takeSharedReadinessChanges,
  type ReadinessChangeTuple,
} from 'internal:scheduler-native';

interface ReadinessChange {
  ident: number;
  filter: number;
  flags: number;
  fflags: number;
  data: number;
  udata: number;
  cancelOwner?: number;
  schedulerWake?: boolean;
  acknowledgement?: number;
}

const EVFILT_READ = -1;
const EVFILT_WRITE = -2;
const EVFILT_TIMER = backend.EVFILT_TIMER;
const EVFILT_PROC = backend.EVFILT_PROC;
const EVFILT_VNODE = backend.EVFILT_VNODE;
const EVFILT_SIGNAL = backend.EVFILT_SIGNAL;
const EV_DELETE = 2;
const TOKEN_BASE = 4294967296;

interface Registration {
  generation: number;
  owner: number;
  change: ReadinessChange;
  cancel(): void;
}

function decodeReadinessChange(tuple: ReadinessChangeTuple): ReadinessChange {
  const [ident, filter, flags, fflags, data, udata, cancelOwner, schedulerWake, acknowledgement] =
    tuple;
  return {
    ident,
    filter,
    flags,
    fflags,
    data,
    udata,
    ...(cancelOwner === null ? {} : { cancelOwner }),
    ...(schedulerWake ? { schedulerWake } : {}),
    ...(acknowledgement === null ? {} : { acknowledgement }),
  };
}

function route(
  owner: number,
  event: {
    ident: number;
    filter: number;
    flags: number;
    fflags: number;
    data: number;
    udata: number;
    routed: true;
  },
  notifyPool: boolean,
): void {
  routeProcessReadiness(owner, serialize(event)[0]!, notifyPool);
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
    return `${Math.floor(change.udata / TOKEN_BASE)}:${change.filter}:${change.ident}`;
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
    if (change.schedulerWake === true) {
      const owner = change.udata;
      const registration = `scheduler:${owner}`;
      const previous = this.#registrations.get(registration);
      const generation = (previous?.generation ?? 0) + 1;
      previous?.cancel();
      const arm = (): void => {
        const ready = loop.readable(change.ident);
        this.#registrations.set(registration, {
          generation,
          owner,
          change,
          cancel: () => loop.removeRead(change.ident),
        });
        void ready.then(() => {
          if (this.#registrations.get(registration)?.generation !== generation) return;
          signalReactorOwner(owner);
          arm();
        });
      };
      arm();
      return;
    }
    const registration = this.#key(change);
    const previous = this.#registrations.get(registration);
    const generation = (previous?.generation ?? 0) + 1;
    const owner = Math.floor(change.udata / TOKEN_BASE);
    previous?.cancel();
    this.#registrations.delete(registration);
    if ((change.flags & EV_DELETE) !== 0) return;
    if (change.filter === EVFILT_VNODE) {
      const cancel = () => loop.removeVnode(change.ident);
      this.#registrations.set(registration, {
        generation,
        owner,
        change,
        cancel,
      });
      loop.vnode(change.ident, change.fflags, (event) => {
        if (this.#registrations.get(registration)?.generation !== generation) return;
        route(
          owner,
          {
            ident: change.ident,
            filter: change.filter,
            flags: 0,
            fflags: event.fflags,
            data: 0,
            udata: change.udata,
            routed: true,
          },
          !this.#readyListeners.has(owner),
        );
        this.#readyListeners.get(owner)?.();
      });
      return;
    }
    if (change.filter === EVFILT_SIGNAL) {
      const cancel = () => loop.removeSignal(change.ident);
      this.#registrations.set(registration, {
        generation,
        owner,
        change,
        cancel,
      });
      loop.signal(change.ident, () => {
        if (this.#registrations.get(registration)?.generation !== generation) return;
        route(
          owner,
          {
            ident: change.ident,
            filter: change.filter,
            flags: 0,
            fflags: 0,
            data: 0,
            udata: change.udata,
            routed: true,
          },
          !this.#readyListeners.has(owner),
        );
        this.#readyListeners.get(owner)?.();
      });
      return;
    }
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
    } else if (change.filter === EVFILT_PROC) {
      ready = loop.proc(change.ident);
      cancel = () => loop.removeProc(change.ident);
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
      route(
        owner,
        {
          ident: change.ident,
          filter: change.filter,
          flags: 0,
          fflags: 0,
          data: typeof available === 'number' ? available : 0,
          udata: change.udata,
          routed: true,
        },
        !this.#readyListeners.has(owner),
      );
      this.#readyListeners.get(owner)?.();
    });
  }
  #drainCommands(): void {
    for (const tuple of takeSharedReadinessChanges()) {
      const change = decodeReadinessChange(tuple);
      try {
        this.#apply(change);
      } finally {
        if (change.acknowledgement !== undefined) {
          acknowledgeProcessReadiness(change.acknowledgement);
        }
      }
    }
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
