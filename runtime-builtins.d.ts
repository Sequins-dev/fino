declare module 'fino:ffi' {
  export interface NativeSymbolSpec {
    parameters?: readonly unknown[];
    result?: unknown;
    nonblocking?: boolean;
  }
  export type NativeSymbolMap = Record<string, NativeSymbolSpec>;
  export type NativeBindings<TSymbols extends NativeSymbolMap> = {
    [K in keyof TSymbols]: (...args: any[]) => any;
  };
  export interface DynamicLibrary<TSymbols extends NativeSymbolMap = NativeSymbolMap> {
    symbols: NativeBindings<TSymbols>;
  }
  export const Pointer: any;
  export function dlopen<TSymbols extends NativeSymbolMap = NativeSymbolMap>(path: string | null, symbols: TSymbols): DynamicLibrary<TSymbols>;
}

declare module 'fino:profiler' {
  export function startProfiling(name?: string): void;
  export function stopProfiling(name?: string): Uint8Array;
}

declare module 'internal:process' {
  export const os: string;
  export const arch: string;
  export const args: string[];
  export const env: Record<string, string | undefined>;
  export const execPath: string;
}

declare module 'internal:async-context' {
  export function drainMicrotasks(): void;
  export function hasPendingV8Tasks(): boolean;
  export function runLoop(step: () => boolean, onDone: () => void): void;
  export function scheduleSync(fn: () => void): void;
  export function createSlot<T>(): symbol;
  export function getSlot<T>(slot: symbol): T | undefined;
  export function setSlot<T>(slot: symbol, value: T): void;
  export function clearSlot(slot: symbol): void;
  export function snapshot(): unknown;
  export function restore(state: unknown): void;
}

declare module 'internal:loader-hooks' {
  export interface OriginalPosition {
    source: string;
    line: number;
    column: number;
  }
  export function lookupOriginalPosition(source: string, line: number, column: number): OriginalPosition | null;
  export function registerResolve(fn: (specifier: string, referrerDir: string | null, root: string) => string): void;
  export function registerInitMeta(
    fn: (
      meta: ImportMeta & { resolve?: (specifier: string) => string },
      filename: string,
      root: string,
    ) => void,
  ): void;
  export function getPackageMap(): string | null;
}

declare module 'internal:docgen' {
  export function extractModule(path: string): string;
}

declare module 'internal:runtime/loop-backend' {
  export const EVFILT_READ: number;
  export const EVFILT_WRITE: number;
  export const EVFILT_TIMER: number;
  export const EVFILT_PROC: number | null;
  export const EVFILT_COMPLETION: number | null;
  export const EVFILT_VNODE: number | null;
  export const EVFILT_SIGNAL: number | null;
  export function create(): object;
  export function destroy(raw: object): void;
  export function addRead(raw: object, fd: number): void;
  export function addWrite(raw: object, fd: number): void;
  export function removeRead(raw: object, fd: number): void;
  export function removeWrite(raw: object, fd: number): void;
  export function addTimer(raw: object, id: number, ms: number): void;
  export function removeTimer(raw: object, id: number): void;
  export const addProc: ((raw: object, pid: number) => void) | undefined;
  export const removeProc: ((raw: object, pid: number) => void) | undefined;
  export const addSignal: ((raw: object, signal: number) => void) | undefined;
  export const removeSignal: ((raw: object, signal: number) => void) | undefined;
  export const addVnode: ((raw: object, fd: number, flags: number) => void) | undefined;
  export const removeVnode: ((raw: object, fd: number) => void) | undefined;
  export function wait(raw: object, timeout: number): Array<{ ident: number; filter: number; flags: number; fflags?: number; res?: number }>;
}

declare global {
  interface ImportMeta {
    filename?: string;
    dirname?: string;
  }

  interface ErrorConstructor {
    prepareStackTrace?: (err: Error, callSites: unknown[]) => string;
  }

  var cryptoAvailable: boolean | undefined;
  var tlsAvailable: boolean | undefined;
}
