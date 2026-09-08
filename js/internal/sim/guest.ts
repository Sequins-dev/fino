/**
 * internal:sim/guest — install simulation-only ambient adapters before entry.
 *
 * This builtin is the entry module used by `simulate()`. Before importing the
 * caller's module, it replaces ambient Fetch with a Facade-backed adapter and
 * disables globals that could bypass the simulation's import map and ordinary
 * Realm RPC journal.
 *
 * @internal
 */

const FETCH_SPECIFIER = 'fino:net/fetch';
const BLOCKED_GLOBALS = [
  'WebSocket',
  'WebTransport',
  'EventSource',
  'BroadcastChannel',
  'SharedArrayBuffer',
] as const;

type FetchProvider = {
  handleRequest(request: {
    method: string;
    url: string;
    headers: Array<[string, string]>;
    body: Uint8Array | null;
  }): Promise<{
    status?: number;
    statusText?: string;
    headers?: Array<[string, string]>;
    body?: Uint8Array<ArrayBuffer> | null;
  }>;
};

async function simulatedFetch(input: string | Request, init?: RequestInit): Promise<Response> {
  let provider: FetchProvider;
  try {
    provider = (await import(FETCH_SPECIFIER)) as FetchProvider;
  } catch (cause) {
    throw new Error(`fino:sim — fetch requires a Facade at ${FETCH_SPECIFIER}`, { cause });
  }

  const request = new Request(input, init);
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? null
      : new Uint8Array(await request.arrayBuffer());
  const response = await provider.handleRequest({
    method: request.method,
    url: request.url,
    headers: [...request.headers],
    body,
  });
  return new Response(response.body ?? null, {
    status: response.status ?? 200,
    statusText: response.statusText ?? '',
    headers: response.headers ?? [],
  });
}

function installFetchAdapter(): void {
  Object.defineProperty(globalThis, 'fetch', {
    value: simulatedFetch,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function installHermeticGlobals(): void {
  for (const name of BLOCKED_GLOBALS) {
    Object.defineProperty(globalThis, name, {
      value: function unavailableInSimulation(): never {
        throw new Error(`fino:sim — ${name} is unavailable in a simulation`);
      },
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
}

/** Install simulation adapters, import `entry`, and invoke its default export. @internal */
export default async function runSimulationEntry(entry: string, args: unknown[]): Promise<unknown> {
  installHermeticGlobals();
  installFetchAdapter();
  const module = await import(entry);
  if (typeof module.default !== 'function') {
    throw new TypeError(`fino:sim — entry '${entry}' must default-export a function`);
  }
  return Reflect.apply(module.default, undefined, args);
}
