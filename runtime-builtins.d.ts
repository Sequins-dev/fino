declare module 'fino:parsing/scanner' {
  export type Encoding = 'utf-8' | 'ascii' | 'latin1' | 'utf-16le' | 'utf-16be';
  export interface ScannerOptions {
    encoding?: Encoding;
    format?: string;
    filename?: string;
  }
  export interface ScannerMark {
    readonly offset: number;
    readonly line?: number;
    readonly column?: number;
  }
  export type ScannerSnapshot = ScannerMark;
  export class ParseError extends Error {
    readonly format: string;
    readonly filename: string | undefined;
    readonly offset: number;
    readonly line: number | undefined;
    readonly column: number | undefined;
    readonly length: number;
    render(options?: { color?: boolean; contextLines?: number }): string;
  }
  export class Scanner {
    constructor(source: string | Uint8Array, options?: ScannerOptions);
    readonly offset: number;
    readonly done: boolean;
    readonly encoding: Encoding | null;
    readonly line: number;
    readonly column: number;
    peekByte(at?: number): number;
    eatByte(): number;
    eatBytes(n: number): Uint8Array;
    matchBytes(b: Uint8Array | readonly number[]): boolean;
    eatUntilByte(c: number, max?: number): Uint8Array;
    bytesSlice(from: ScannerMark, to?: ScannerMark): Uint8Array;
    readU8(): number;   readI8(): number;
    readU16BE(): number; readU16LE(): number;
    readI16BE(): number; readI16LE(): number;
    readU32BE(): number; readU32LE(): number;
    readI32BE(): number; readI32LE(): number;
    readU64BE(): bigint; readU64LE(): bigint;
    readI64BE(): bigint; readI64LE(): bigint;
    readF32BE(): number; readF32LE(): number;
    readF64BE(): number; readF64LE(): number;
    eatText(byteLength: number, encoding?: Encoding): string;
    peek(n?: number): string;
    peekCode(n?: number): number;
    eat(n?: number): string;
    eatChar(s: string): boolean;
    match(s: string): boolean;
    eatWhile(pred: (code: number) => boolean): string;
    eatUntil(pred: (code: number) => boolean): string;
    expect(s: string, message?: string): void;
    skipSpaceTab(): void;
    skipWhitespace(): void;
    text(from: ScannerMark, to?: ScannerMark): string;
    mark(): ScannerMark;
    snapshot(): ScannerSnapshot;
    restore(s: ScannerSnapshot): void;
    error(detail: string, span?: ScannerMark | { from: ScannerMark; to: ScannerMark }): ParseError;
  }
}

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
  export function getCPED(): unknown;
  export function setCPED(value: unknown): void;
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

// Shorthand ambient declarations for fino: built-in modules that don't have
// explicit tsconfig path mappings (e.g. fino:bench, fino:abort, fino:crypto…).
// Shorthand form makes all exports `any`; modules with explicit paths override.
declare module 'fino:abort';
declare module 'fino:blob';
declare module 'fino:console';
declare module 'fino:context';
declare module 'fino:crypto';
declare module 'fino:dns';
declare module 'fino:encoding';
declare module 'fino:eventtarget';
declare module 'fino:formdata';
declare module 'fino:loop';
declare module 'fino:path';
declare module 'fino:process';
declare module 'fino:socket';
declare module 'fino:time';
declare module 'fino:url';
declare module 'fino:urlpattern';
declare module 'fino:webstreams';

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

  // Atomics.waitAsync — not yet in TypeScript's lib.esnext.atomics but supported in V8.
  interface Atomics {
    waitAsync(
      typedArray: Int32Array | BigInt64Array,
      index: number,
      value: number | bigint,
      timeout?: number,
    ): { async: false; value: 'ok' | 'not-equal' | 'timed-out' }
      | { async: true; value: Promise<'ok' | 'timed-out'> };
  }
}
