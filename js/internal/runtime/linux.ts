/**
 * internal:runtime/linux — Linux event-loop backend selector.
 *
 * Linux normally uses io_uring for readiness, timers, signals, and file
 * completions. Some production-like environments, including Docker with its
 * default seccomp profile, can deny io_uring_setup(2). This selector probes
 * io_uring once during loop creation and falls back to the poll(2) backend
 * when the kernel or sandbox rejects ring setup.
 *
 * @internal
 */

import * as ioUring from './io_uring.ts';
import * as pollBackend from './poll.ts';

type BackendKind = 'io_uring' | 'poll';

interface SelectedLoop {
  kind: BackendKind;
  raw: object;
}

/**
 * Kqueue-compatible read readiness filter.
 *
 * @internal
 */
export const EVFILT_READ = ioUring.EVFILT_READ;
/**
 * Kqueue-compatible write readiness filter.
 *
 * @internal
 */
export const EVFILT_WRITE = ioUring.EVFILT_WRITE;
/**
 * Kqueue-compatible timer filter.
 *
 * @internal
 */
export const EVFILT_TIMER = ioUring.EVFILT_TIMER;
/**
 * Kqueue-compatible signal filter.
 *
 * @internal
 */
export const EVFILT_SIGNAL = ioUring.EVFILT_SIGNAL;
/**
 * Completion filter used by `loop.submit()`.
 *
 * @internal
 */
export const EVFILT_COMPLETION = ioUring.EVFILT_COMPLETION;

/**
 * Create the best available Linux backend.
 *
 * @internal
 */
export function create(): SelectedLoop {
  try {
    return { kind: 'io_uring', raw: ioUring.create() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('io_uring_setup failed')) throw error;
    return { kind: 'poll', raw: pollBackend.create() };
  }
}

/**
 * Register read readiness.
 *
 * @internal
 */
export function addRead(loop: SelectedLoop, fd: number, userData: number): void {
  if (loop.kind === 'io_uring') ioUring.addRead(loop.raw as any, fd, userData);
  else pollBackend.addRead(loop.raw as any, fd, userData);
}

/**
 * Register persistent read readiness.
 *
 * @internal
 */
export function addPersistentRead(loop: SelectedLoop, fd: number, userData: number): void {
  if (loop.kind === 'io_uring') ioUring.addPersistentRead(loop.raw as any, fd, userData);
  else pollBackend.addPersistentRead(loop.raw as any, fd, userData);
}

/**
 * Register write readiness.
 *
 * @internal
 */
export function addWrite(loop: SelectedLoop, fd: number, userData: number): void {
  if (loop.kind === 'io_uring') ioUring.addWrite(loop.raw as any, fd, userData);
  else pollBackend.addWrite(loop.raw as any, fd, userData);
}

/**
 * Remove read readiness.
 *
 * @internal
 */
export function removeRead(loop: SelectedLoop, fd: number): void {
  if (loop.kind === 'io_uring') ioUring.removeRead(loop.raw as any, fd);
  else pollBackend.removeRead(loop.raw as any, fd);
}

/**
 * Remove write readiness.
 *
 * @internal
 */
export function removeWrite(loop: SelectedLoop, fd: number): void {
  if (loop.kind === 'io_uring') ioUring.removeWrite(loop.raw as any, fd);
  else pollBackend.removeWrite(loop.raw as any, fd);
}

/**
 * Register a timer.
 *
 * @internal
 */
export function addTimer(loop: SelectedLoop, id: number, ms: number): void {
  if (loop.kind === 'io_uring') ioUring.addTimer(loop.raw as any, id, ms);
  else pollBackend.addTimer(loop.raw as any, id, ms);
}

/**
 * Remove a timer when supported.
 *
 * @internal
 */
export function removeTimer(loop: SelectedLoop, id: number): void {
  if (loop.kind === 'io_uring') ioUring.removeTimer(loop.raw as any, id);
  else pollBackend.removeTimer(loop.raw as any, id);
}

/**
 * Register signal delivery.
 *
 * @internal
 */
export function addSignal(loop: SelectedLoop, signo: number): void {
  if (loop.kind === 'io_uring') ioUring.addSignal(loop.raw as any, signo);
  else pollBackend.addSignal(loop.raw as any, signo);
}

/**
 * Remove signal delivery.
 *
 * @internal
 */
export function removeSignal(loop: SelectedLoop, signo: number): void {
  if (loop.kind === 'io_uring') ioUring.removeSignal(loop.raw as any, signo);
  else pollBackend.removeSignal(loop.raw as any, signo);
}

/**
 * Wait for events.
 *
 * @internal
 */
export function wait(loop: SelectedLoop, timeoutMs: number | null = null): any[] {
  if (loop.kind === 'io_uring') return ioUring.wait(loop.raw as any, timeoutMs);
  return pollBackend.wait(loop.raw as any, timeoutMs);
}

/**
 * Non-blocking poll for events.
 *
 * @internal
 */
export function poll(loop: SelectedLoop): any[] {
  if (loop.kind === 'io_uring') return ioUring.poll(loop.raw as any);
  return pollBackend.poll(loop.raw as any);
}

/**
 * Submit an open operation.
 *
 * @internal
 */
export function asyncOpen(loop: SelectedLoop, pathBuf: ArrayBuffer, flags: number, mode: number, userData: number): void {
  if (loop.kind === 'io_uring') ioUring.asyncOpen(loop.raw as any, pathBuf, flags, mode, userData);
  else pollBackend.asyncOpen(loop.raw as any, pathBuf, flags, mode, userData);
}

/**
 * Submit a read operation.
 *
 * @internal
 */
export function asyncRead(loop: SelectedLoop, fd: number, buf: ArrayBuffer, len: number, userData: number): void {
  if (loop.kind === 'io_uring') ioUring.asyncRead(loop.raw as any, fd, buf, len, userData);
  else pollBackend.asyncRead(loop.raw as any, fd, buf, len, userData);
}

/**
 * Submit a close operation.
 *
 * @internal
 */
export function asyncClose(loop: SelectedLoop, fd: number, userData: number): void {
  if (loop.kind === 'io_uring') ioUring.asyncClose(loop.raw as any, fd, userData);
  else pollBackend.asyncClose(loop.raw as any, fd, userData);
}

/**
 * Destroy the selected backend.
 *
 * @internal
 */
export function destroy(loop: SelectedLoop): void {
  if (loop.kind === 'io_uring') ioUring.destroy(loop.raw as any);
  else pollBackend.destroy(loop.raw as any);
}
