/**
* fino:ai/sandbox — capability-gated execution for model-written TypeScript.
*
* An `AISandbox` runs source in a separate process Realm with a deny-all import
* map. The child can import only `fino:ai/sandbox/capabilities`; every operation
* in that synthetic module is checked and executed by the parent. Ambient
* network globals are removed before user source evaluates.
*
* Grants are explicit values, not booleans: filesystem grants name roots,
* network grants name origins and methods, subprocess grants name binaries,
* and environment/secret grants contain only the names visible to the child.
* Resource limits bound capability calls and transferred bytes. Subprocesses
* additionally use the runtime's strict process sandbox and fail closed when
* the host cannot enforce it.
*
* Audit events are published on `fino:ai/sandbox`. They contain capability
* names and targets but never environment or secret values.
*
* ```ts no_run
* import { AISandbox } from 'fino:ai/sandbox';
*
* const code = `
*   import { environment, readText } from 'fino:ai/sandbox/capabilities';
*   export default async (path: string) => ({
*     mode: await environment('MODE'),
*     text: await readText(path),
*   });
* `;
* using sandbox = new AISandbox(code, {
*   environment: { MODE: 'analysis' },
*   filesystem: { read: ['/srv/input'] },
* });
* console.log(await sandbox.call('/srv/input/prompt.txt'));
* ```
*/
import { topic } from 'fino:context/topic';
import { DiskFileSystem } from 'fino:file';
import { basename, dirname, isAbsolute, join, normalize } from 'fino:file/path';
import { Process, SIGKILL } from 'fino:process';
import type { ProcessSandboxOptions } from 'fino:process';
import { Facade, ImportMap, Realm } from 'fino:realm';
const CAPABILITY_SPECIFIER = 'fino:ai/sandbox/capabilities';
const auditTopic = topic<SandboxAuditEvent>('fino:ai/sandbox');
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fs = new DiskFileSystem();
/**
* Filesystem roots visible to sandbox code.
*/
export interface SandboxFilesystemGrant {
  /** Absolute roots from which `readText()` may read. */
  read?: string[];
  /** Absolute roots beneath which `writeText()` may write. */
  write?: string[];
}
/**
* HTTP requests visible to sandbox code.
*/
export interface SandboxNetworkGrant {
  /** Exact URL origins such as `https://api.example.com`. */
  origins: string[];
  /** Allowed methods. Defaults to `GET`. */
  methods?: string[];
}
/**
* Strictly sandboxed child-process access.
*/
export interface SandboxSubprocessGrant {
  /** Exact executable paths the child may request. */
  commands: string[];
  /** Replacement environment for spawned commands. Defaults to empty. */
  environment?: Record<string, string>;
  /** Strict runtime sandbox policy. A fail-closed default is used when omitted. */
  sandbox?: ProcessSandboxOptions;
  /** Maximum command runtime. Defaults to 30 seconds. */
  timeoutMs?: number;
}
/**
* Limits shared across one sandbox lifetime.
*/
export interface SandboxResourceGrant {
  /** Maximum parent-side capability calls. Defaults to 100. */
  maxOperations?: number;
  /** Maximum bytes returned by one file read. Defaults to 1 MiB. */
  maxReadBytes?: number;
  /** Maximum bytes accepted by one file write. Defaults to 1 MiB. */
  maxWriteBytes?: number;
  /** Maximum bytes returned by one HTTP response. Defaults to 1 MiB. */
  maxNetworkBytes?: number;
  /** Maximum combined stdout and stderr bytes. Defaults to 1 MiB. */
  maxProcessOutputBytes?: number;
  /** Maximum elapsed time for one `call()`. Defaults to 30 seconds. */
  wallClockMs?: number;
}
/**
* Capability grants supplied by trusted parent code.
*/
export interface AISandboxOptions {
  /** Scoped file access. Omit to deny all filesystem operations. */
  filesystem?: SandboxFilesystemGrant;
  /** Scoped outbound HTTP access. Omit to deny all network operations. */
  network?: SandboxNetworkGrant;
  /** Scoped subprocess access. Omit to deny all process creation. */
  subprocess?: SandboxSubprocessGrant;
  /** Exact environment variable names and values visible to the child. */
  environment?: Record<string, string>;
  /** Exact secret names and values visible to the child. Values are never audited. */
  secrets?: Record<string, string>;
  /** Operation, byte, and elapsed-time limits. */
  resources?: SandboxResourceGrant;
}
/**
* Event published for sandbox capability use, denial, and execution results.
*/
export interface SandboxAuditEvent {
  /** Capability such as `filesystem.read`, `secret`, or `execute`. */
  capability: string;
  /** Requested name, path, origin, or executable. Never a secret value. */
  target?: string;
  /** Whether the operation was used, denied, or failed after authorization. */
  outcome: 'used' | 'denied' | 'error';
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  /** Human-readable denial or failure reason. */
  reason?: string;
}
/**
* Structured error for a denied capability or exhausted resource grant.
*/
export class SandboxDeniedError extends Error {
  /** Capability that rejected the request. */
  readonly capability: string;
  /** Requested target, when one is safe to expose. */
  readonly target?: string;
  /** Create a capability denial. Applications normally receive these from an `AISandbox`. */
  constructor(capability: string, message: string, target?: string) {
    super(message);
    this.name = 'SandboxDeniedError';
    this.capability = capability;
    this.target = target;
  }
}
interface NormalizedResources {
  maxOperations: number;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxNetworkBytes: number;
  maxProcessOutputBytes: number;
  wallClockMs: number;
}
function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}
function normalizeResources(input: SandboxResourceGrant = {}): NormalizedResources {
  return {
    maxOperations: positiveInteger('resources.maxOperations', input.maxOperations, 100),
    maxReadBytes: positiveInteger('resources.maxReadBytes', input.maxReadBytes, 1024 * 1024),
    maxWriteBytes: positiveInteger('resources.maxWriteBytes', input.maxWriteBytes, 1024 * 1024),
    maxNetworkBytes: positiveInteger('resources.maxNetworkBytes', input.maxNetworkBytes, 1024 * 1024),
    maxProcessOutputBytes: positiveInteger('resources.maxProcessOutputBytes', input.maxProcessOutputBytes, 1024 * 1024),
    wallClockMs: positiveInteger('resources.wallClockMs', input.wallClockMs, 3e4)
  };
}
function normalizeRoots(name: string, roots: string[] | undefined): string[] {
  return (roots ?? []).map((root) => {
    if (!isAbsolute(root)) throw new TypeError(`${name} roots must be absolute`);
    return normalize(root).toString().replace(/\/+$/, '') || '/';
  });
}
function isWithin(path: string, root: string): boolean {
  return root === '/' || path === root || path.startsWith(`${root}/`);
}
async function canonicalReadPath(path: string, roots: string[]): Promise<string | null> {
  if (!isAbsolute(path)) return null;
  const resolved = await fs.realpath(path);
  for (const root of roots) {
    const canonicalRoot = await fs.realpath(root);
    if (isWithin(resolved, canonicalRoot)) return resolved;
  }
  return null;
}
async function canonicalWritePath(path: string, roots: string[]): Promise<string | null> {
  if (!isAbsolute(path)) return null;
  const clean = normalize(path).toString();
  const parent = await fs.realpath(dirname(clean));
  const resolved = join(parent, basename(clean)).toString();
  for (const root of roots) {
    const canonicalRoot = await fs.realpath(root);
    if (isWithin(resolved, canonicalRoot)) return resolved;
  }
  return null;
}
async function collect(source: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    length += chunk.byteLength;
    if (length > limit) throw new SandboxDeniedError('resource.bytes', `Sandbox byte limit exceeded (${limit})`);
    chunks.push(chunk);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
async function collectShared(source: AsyncIterable<Uint8Array>, limit: number, total: {
  length: number;
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    length += chunk.byteLength;
    total.length += chunk.byteLength;
    if (total.length > limit) {
      throw new SandboxDeniedError('resource.bytes', `Sandbox process output exceeds ${limit} bytes`);
    }
    chunks.push(chunk);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
function hardenedSource(source: string): string {
  return `
for (const name of [
  'fetch', 'EventSource', 'WebSocket', 'WebTransport',
  'WebTransportDatagramDuplexStream', 'BroadcastChannel'
]) {
  Object.defineProperty(globalThis, name, {
    value: undefined,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}
${source}`;
}
/**
* A single-use, process-isolated, parent-capability-backed TypeScript execution
* context. Single-use execution avoids retaining a privileged RPC channel after
* model-written code returns.
*
* Call `terminate()` or use explicit resource management when done.
*/
export class AISandbox<F extends (...args: any[]) => any = (...args: any[]) => any> {
  #createRealm: () => Realm<F>;
  #active = new Set<Realm<F>>();
  #resources: NormalizedResources;
  #operations = 0;
  #called = false;
  #terminated = false;
  /**
  * Validate grants and prepare source for a deny-by-default process Realm.
  *
  * Invalid grants throw during construction. Source transpilation and process
  * creation happen when `call()` starts. Capability operations fail with
  * `SandboxDeniedError`; child failures reject `call()`.
  */
  constructor(source: string, options: AISandboxOptions = {}) {
    this.#resources = normalizeResources(options.resources);
    const readRoots = normalizeRoots('filesystem.read', options.filesystem?.read);
    const writeRoots = normalizeRoots('filesystem.write', options.filesystem?.write);
    const origins = new Set((options.network?.origins ?? []).map((origin) => new URL(origin).origin));
    const methods = new Set((options.network?.methods ?? ['GET']).map((method) => method.toUpperCase()));
    const commands = new Set(options.subprocess?.commands ?? []);
    const emit = (event: Omit<SandboxAuditEvent, 'timestamp'>) => {
      auditTopic.publish({
        ...event,
        timestamp: Date.now()
      });
    };
    const deny = (capability: string, message: string, target?: string): never => {
      emit({
        capability,
        target,
        outcome: 'denied',
        reason: message
      });
      throw new SandboxDeniedError(capability, message, target);
    };
    const consume = (capability: string, target?: string) => {
      this.#operations++;
      if (this.#operations > this.#resources.maxOperations) {
        deny('resource.operations', `Sandbox operation budget exceeded (${this.#resources.maxOperations})`, target);
      }
      return async <T>(fn: () => Promise<T> | T): Promise<T> => {
        try {
          const result = await fn();
          emit({
            capability,
            target,
            outcome: 'used'
          });
          return result;
        } catch (error) {
          if (error instanceof SandboxDeniedError) throw error;
          emit({
            capability,
            target,
            outcome: 'error',
            reason: String(error)
          });
          throw error;
        }
      };
    };
    const createFacade = () => new Facade(CAPABILITY_SPECIFIER, [
      'environment',
      'secret',
      'readText',
      'writeText',
      'fetchText',
      'spawn'
    ]).handle('environment', (name) => {
      const key = String(name);
      if (!Object.hasOwn(options.environment ?? {}, key)) {
        deny('environment', `Environment variable ${key} is not granted`, key);
      }
      return consume('environment', key)(() => options.environment![key]!);
    }).handle('secret', (name) => {
      const key = String(name);
      if (!Object.hasOwn(options.secrets ?? {}, key)) {
        deny('secret', `Secret ${key} is not granted`, key);
      }
      return consume('secret', key)(() => options.secrets![key]!);
    }).handle('readText', async (path) => {
      const target = String(path);
      if (readRoots.length === 0) deny('filesystem.read', `Filesystem read is not granted for ${target}`, target);
      const canonical = await canonicalReadPath(target, readRoots);
      if (canonical === null) deny('filesystem.read', `Filesystem read is not granted for ${target}`, target);
      return consume('filesystem.read', target)(async () => {
        const bytes = await fs.readFile(canonical);
        if (bytes.byteLength > this.#resources.maxReadBytes) {
          deny('resource.bytes', `Sandbox file read exceeds ${this.#resources.maxReadBytes} bytes`, target);
        }
        return decoder.decode(bytes);
      });
    }).handle('writeText', async (path, text) => {
      const target = String(path);
      if (writeRoots.length === 0) deny('filesystem.write', `Filesystem write is not granted for ${target}`, target);
      const canonical = await canonicalWritePath(target, writeRoots);
      if (canonical === null) deny('filesystem.write', `Filesystem write is not granted for ${target}`, target);
      const bytes = encoder.encode(String(text));
      if (bytes.byteLength > this.#resources.maxWriteBytes) {
        deny('resource.bytes', `Sandbox file write exceeds ${this.#resources.maxWriteBytes} bytes`, target);
      }
      return consume('filesystem.write', target)(async () => {
        await fs.writeFile(canonical, bytes);
      });
    }).handle('fetchText', async (url, init) => {
      const target = String(url);
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        deny('network', `Network URL is invalid: ${target}`, target);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        deny('network', `Network protocol is not granted: ${parsed.protocol}`, parsed.protocol);
      }
      const method = String((init as {
        method?: unknown;
      } | undefined)?.method ?? 'GET').toUpperCase();
      if (!origins.has(parsed.origin) || !methods.has(method)) {
        deny('network', `Network request is not granted: ${method} ${target}`, parsed.origin);
      }
      return consume('network', parsed.origin)(async () => {
        const response = await fetch(target, {
          method,
          headers: (init as {
            headers?: HeadersInit;
          } | undefined)?.headers,
          body: (init as {
            body?: string;
          } | undefined)?.body,
          redirect: 'error'
        });
        const body = response.body === null ? new Uint8Array() : await collect(response.body, this.#resources.maxNetworkBytes);
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: decoder.decode(body)
        };
      });
    }).handle('spawn', async (command, args) => {
      const executable = String(command);
      if (!commands.has(executable)) {
        deny('subprocess', `Subprocess command is not granted: ${executable}`, executable);
      }
      const argv = Array.isArray(args) ? args.map(String) : [];
      return consume('subprocess', executable)(async () => {
        const timeoutMs = positiveInteger('subprocess.timeoutMs', options.subprocess?.timeoutMs, 3e4);
        const policy = options.subprocess?.sandbox ?? {
          mode: 'strict',
          network: {
            outbound: [{
              action: 'deny',
              destination: '*'
            }],
            inbound: [{
              action: 'deny',
              destination: '*'
            }]
          },
          process: { allowedBinaries: [executable] }
        } satisfies ProcessSandboxOptions;
        const process = new Process(executable, argv, {
          env: options.subprocess?.environment ?? {},
          sandbox: policy
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            try {
              process.kill(SIGKILL);
            } catch {}
            reject(new SandboxDeniedError('resource.wallClock', `Sandbox subprocess exceeded ${timeoutMs}ms`, executable));
          }, timeoutMs);
        });
        try {
          const output = { length: 0 };
          const [stdout, stderr, result] = await Promise.race([Promise.all([
            collectShared(process.stdout, this.#resources.maxProcessOutputBytes, output),
            collectShared(process.stderr, this.#resources.maxProcessOutputBytes, output),
            process.wait()
          ]), timeout]);
          return {
            ...result,
            stdout: decoder.decode(stdout),
            stderr: decoder.decode(stderr)
          };
        } catch (error) {
          try {
            process.kill(SIGKILL);
          } catch {}
          throw error;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      });
    });
    this.#createRealm = () => Realm.fromSource<F>(hardenedSource(source), {
      process: true,
      otlpEndpoint: false,
      overrides: ImportMap.deny([{
        pattern: CAPABILITY_SPECIFIER,
        directive: createFacade()
      }])
    });
  }
  /**
  * Invoke the source module's default export.
  *
  * The elapsed-time limit rejects and terminates the sandbox. Capability
  * counters and byte limits apply to this single execution.
  */
  async call(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> {
    if (this.#terminated) throw new Error('AI sandbox is terminated');
    if (this.#called) throw new Error('AI sandbox is single-use');
    this.#called = true;
    const realm = this.#createRealm();
    this.#active.add(realm);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.terminate();
        const reason = `Sandbox call exceeded ${this.#resources.wallClockMs}ms`;
        auditTopic.publish({
          capability: 'resource.wallClock',
          outcome: 'denied',
          reason,
          timestamp: Date.now()
        });
        reject(new SandboxDeniedError('resource.wallClock', reason));
      }, this.#resources.wallClockMs);
    });
    try {
      const result = await Promise.race([realm.call(...args), timeout]);
      auditTopic.publish({
        capability: 'execute',
        outcome: 'used',
        timestamp: Date.now()
      });
      return result as Awaited<ReturnType<F>>;
    } catch (error) {
      auditTopic.publish({
        capability: 'execute',
        outcome: 'denied',
        reason: String(error),
        timestamp: Date.now()
      });
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      realm.terminate({ force: true });
      this.#active.delete(realm);
    }
  }
  /**
  * Stop the process Realm. Repeated calls are harmless.
  */
  terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    for (const realm of this.#active) realm.terminate({ force: true });
    this.#active.clear();
  }
  /**
  * Explicit resource management hook.
  */
  [Symbol.dispose](): void {
    this.terminate();
  }
}
