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
import {
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
  schedulerPoll?: boolean;
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
  const [ident, filter, flags, fflags, data, udata, cancelOwner, schedulerWake, schedulerPoll] =
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
    ...(schedulerPoll ? { schedulerPoll } : {}),
  };
}

/**
 * Hand one readiness completion to its owning realm.
 *
 * A completion is seven scalars the kernel already produced, so it crosses as
 * scalars. It used to be structured-cloned — encode, allocate, decode — to move
 * a handful of numbers between two realms in the same process.
 */
function route(
  owner: number,
  event: {
    ident: number;
    filter: number;
    flags: number;
    fflags: number;
    data: number;
    udata: number;
    installed?: boolean;
  },
): void {
  routeProcessReadiness(
    owner,
    event.ident,
    event.filter,
    event.flags,
    event.fflags,
    event.data,
    event.udata,
    event.installed === true ? 1 : 0,
    true,
  );
}

/**
 * Tell an owner that its persistent watch is now armed on the process backend.
 *
 * Vnode and signal watches are level-triggered and long-lived, so a realm that
 * needs to observe everything from a known point has to know when the watch
 * actually exists. Reporting installation as an ordinary routed completion
 * keeps that handshake on the same signal path as every other readiness event,
 * rather than blocking the reactor thread that issued the registration.
 */
function routeInstalled(owner: number, change: ReadinessChange): void {
  route(owner, {
    ident: change.ident,
    filter: change.filter,
    flags: 0,
    fflags: 0,
    data: 0,
    udata: change.udata,
    installed: true,
  });
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
    if (change.schedulerPoll === true) {
      // A reactor thread parked a realm whose remaining work the kernel cannot
      // report on. Hold the wait here, on the thread already sleeping in the
      // backend, and re-signal the owner when it elapses. Keyed per owner so a
      // realm never accumulates overlapping polls.
      const owner = change.udata;
      const registration = `poll:${owner}`;
      const previous = this.#registrations.get(registration);
      const generation = (previous?.generation ?? 0) + 1;
      previous?.cancel();
      const timer = loop.timeout(change.data);
      this.#registrations.set(registration, {
        generation,
        owner,
        change,
        cancel: () => timer.cancel(),
      });
      void timer.then(() => {
        if (this.#registrations.get(registration)?.generation !== generation) return;
        this.#registrations.delete(registration);
        signalReactorOwner(owner);
      });
      return;
    }
    if (change.schedulerWake === true) {
      const owner = change.udata;
      const registration = `scheduler:${owner}`;
      const previous = this.#registrations.get(registration);
      const generation = (previous?.generation ?? 0) + 1;
      previous?.cancel();
      // Tag the wake fd with the owning realm's token for that descriptor, so
      // it cannot collide with a readiness watch this realm installs for some
      // other owner that happens to have the same descriptor number.
      const token = owner * TOKEN_BASE + (change.ident >>> 0);
      const arm = (): void => {
        const ready = loop.readable(change.ident, token);
        this.#registrations.set(registration, {
          generation,
          owner,
          change,
          cancel: () => loop.removeRead(change.ident, token),
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
      const cancel = () => loop.removeVnode(change.ident, change.udata);
      this.#registrations.set(registration, {
        generation,
        owner,
        change,
        cancel,
      });
      loop.vnode(
        change.ident,
        change.fflags,
        (event) => {
          if (this.#registrations.get(registration)?.generation !== generation) return;
          route(owner, {
            ident: change.ident,
            filter: change.filter,
            flags: 0,
            fflags: event.fflags,
            data: 0,
            udata: change.udata,
          });
        },
        change.udata,
      );
      routeInstalled(owner, change);
      return;
    }
    if (change.filter === EVFILT_SIGNAL) {
      const cancel = () => loop.removeSignal(change.ident, change.udata);
      this.#registrations.set(registration, {
        generation,
        owner,
        change,
        cancel,
      });
      loop.signal(
        change.ident,
        () => {
          if (this.#registrations.get(registration)?.generation !== generation) return;
          route(owner, {
            ident: change.ident,
            filter: change.filter,
            flags: 0,
            fflags: 0,
            data: 0,
            udata: change.udata,
          });
        },
        change.udata,
      );
      routeInstalled(owner, change);
      return;
    }
    let cancel: () => void;
    let ready: Promise<number | void>;
    if (change.filter === EVFILT_READ) {
      ready = loop.readable(change.ident, change.udata);
      cancel = () => loop.removeRead(change.ident, change.udata);
    } else if (change.filter === EVFILT_WRITE) {
      ready = loop.writable(change.ident, change.udata);
      cancel = () => loop.removeWrite(change.ident, change.udata);
    } else if (change.filter === EVFILT_TIMER) {
      const timer = loop.timeout(change.data);
      ready = timer;
      cancel = () => timer.cancel();
    } else if (change.filter === EVFILT_PROC) {
      ready = loop.proc(change.ident, change.udata);
      cancel = () => loop.removeProc(change.ident, change.udata);
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
      route(owner, {
        ident: change.ident,
        filter: change.filter,
        flags: 0,
        fflags: 0,
        data: typeof available === 'number' ? available : 0,
        udata: change.udata,
      });
    });
  }
  #drainCommands(): void {
    for (const tuple of takeSharedReadinessChanges()) {
      this.#apply(decodeReadinessChange(tuple));
    }
  }
  /** Drain queued registrations and begin watching the native mailbox. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#drainCommands();
    loop.registerWakeSource(this.controlFd, () => this.#drainCommands());
  }
  /** Remove all process-workload and mailbox readiness watches. */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    loop.unregisterWakeSource(this.controlFd);
    for (const active of this.#registrations.values()) active.cancel();
    this.#registrations.clear();
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
