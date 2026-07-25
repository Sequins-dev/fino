/**
* internal:scheduler/reactor — process-wide TypeScript readiness owner.
*
* This realm is permanently entered on its own thread. Workload realms send it
* scalar readiness registrations through the native command mailbox. It owns
* the one io_uring/kqueue instance, waits through the ordinary TypeScript loop,
* and routes scalar completions back to the process workload pool. Actual
* reads, writes, buffers, and retry policy stay in the destination workload.
*
* @internal
*/
import * as loop from 'internal:runtime/loop';
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
const EV_DELETE = 2;
const TOKEN_BASE = 4294967296;
interface Registration {
  generation: number;
  owner: number;
  change: ReadinessChange;
}
const registrations = new Map<string, Registration>();
function key(change: ReadinessChange): string {
  return `${change.filter}:${change.ident}`;
}
function cancel(change: ReadinessChange): void {
  if (change.filter === EVFILT_READ) loop.removeRead(change.ident);
  else if (change.filter === EVFILT_WRITE) loop.removeWrite(change.ident);
}
function apply(change: ReadinessChange): void {
  if (change.cancelOwner !== undefined) {
    for (const [registration, active] of registrations) {
      if (active.owner !== change.cancelOwner) continue;
      registrations.delete(registration);
      cancel(active.change);
    }
    return;
  }
  const registration = key(change);
  const previous = registrations.get(registration);
  const generation = (previous?.generation ?? 0) + 1;
  const owner = Math.floor(change.udata / TOKEN_BASE);
  cancel(change);
  registrations.delete(registration);
  if ((change.flags & EV_DELETE) !== 0) return;
  registrations.set(registration, {
    generation,
    owner,
    change
  });
  const ready = change.filter === EVFILT_READ ? loop.readable(change.ident) : loop.writable(change.ident);
  void ready.then((available) => {
    if (registrations.get(registration)?.generation !== generation) return;
    registrations.delete(registration);
    routeProcessReadiness(owner, change.ident, change.filter, 0, 0, typeof available === 'number' ? available : 0, change.udata);
  });
}
function drainCommands(): void {
  const changes = JSON.parse(takeSharedReadinessChanges()) as ReadinessChange[];
  for (const change of changes) apply(change);
}
/**
* Own the process readiness backend and route completions until shutdown.
*
* `controlFd` is the native registration-mailbox wake pipe. The returned
* promise intentionally never settles during normal process execution.
*
* @internal
*/
export default async function runProcessReadinessReactor(input: {
  controlFd: number;
}): Promise<never> {
  while (true) {
    drainCommands();
    await loop.readable(input.controlFd);
  }
}
