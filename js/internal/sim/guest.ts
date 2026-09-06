/**
 * internal:sim/guest — install simulation-only ambient adapters before entry.
 *
 * This builtin is the entry module used by `simulate()`. It replaces ambient
 * Fetch with a Facade-backed adapter before importing the caller's module, so
 * HTTP access remains governed by the simulation's import map and appears in
 * the ordinary Realm RPC journal.
 *
 * @internal
 */

const FETCH_SPECIFIER = 'fino:net/fetch';

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

/** Install simulation adapters, import `entry`, and invoke its default export. @internal */
export default async function runSimulationEntry(entry: string, args: unknown[]): Promise<unknown> {
  installFetchAdapter();
  const module = await import(entry);
  if (typeof module.default !== 'function') {
    throw new TypeError(`fino:sim — entry '${entry}' must default-export a function`);
  }
  return Reflect.apply(module.default, undefined, args);
}
