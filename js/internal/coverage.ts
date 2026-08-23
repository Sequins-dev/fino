/**
 * internal:coverage — V8 precise-coverage protocol client.
 *
 * Coverage-specific Chrome DevTools Protocol behavior lives here rather than
 * in the Rust inspector binding. Coverage run identity, Realm inheritance,
 * crash placeholders, normalization, and aggregation are all implemented in
 * TypeScript. Native code provides only generic inspector transport, loader
 * source-map access, and Realm bootstrap-data transport.
 *
 * The collector implements the precise-coverage subset of:
 *
 * - [Chrome DevTools Protocol: Profiler](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/)
 * - [Chrome DevTools Protocol: Debugger](https://chromedevtools.github.io/devtools-protocol/tot/Debugger/)
 *
 * V8 returns generated JavaScript ranges. TypeScript normalization maps their
 * end-exclusive UTF-16 offsets according to [ECMA-426](https://tc39.es/ecma426/)
 * by decoding source-map JSON obtained through Fino's generic loader hook.
 *
 * @internal
 */
import { dispatch, nextId, onMessage } from 'internal:inspector';
import { version as runtimeVersion } from 'internal:process';
import { pid } from '../process.ts';
import { writeCoveragePlaceholderSync } from 'internal:coverage/model';
import type {
  CoverageRealm,
  CoverageRealmContext,
  CoverageRunConfig,
  CoverageSnapshot,
  CoverageSummary,
  RawScript,
} from 'internal:coverage/model';

interface ProtocolError {
  code?: number;
  message?: string;
}

interface ProtocolResponse {
  id?: number;
  result?: unknown;
  error?: ProtocolError;
}

interface PreciseCoverageResult {
  result: RawScript[];
  timestamp?: number;
}

/** A synchronous request function used by the coverage protocol client. @internal */
export type CoverageProtocolRequest = (method: string, params: object) => unknown;

/** The precise-coverage operations needed by Realm lifecycle code. @internal */
export interface CoverageProtocol {
  start(): void;
  take(): CoverageSnapshot;
}

let expectedResponseId: number | undefined;
let expectedResponse: ProtocolResponse | undefined;
let messageHandlerInstalled = false;

function ensureMessageHandler(): void {
  if (messageHandlerInstalled) return;
  onMessage((message: string) => {
    let response: ProtocolResponse;
    try {
      response = JSON.parse(message) as ProtocolResponse;
    } catch {
      return;
    }
    if (response.id === expectedResponseId) expectedResponse = response;
  });
  messageHandlerInstalled = true;
}

function request(method: string, params: object = {}): unknown {
  if (expectedResponseId !== undefined) {
    throw new Error(`Inspector request ${method} was re-entered`);
  }
  ensureMessageHandler();
  const id = nextId();
  expectedResponseId = id;
  expectedResponse = undefined;
  try {
    dispatch(JSON.stringify({ id, method, params }));
    const response = expectedResponse;
    if (response === undefined) throw new Error(`V8 inspector did not answer ${method}`);
    if (response.error !== undefined) {
      const detail = response.error.message ?? JSON.stringify(response.error);
      throw new Error(`${method}: ${detail}`);
    }
    return response.result ?? {};
  } finally {
    expectedResponseId = undefined;
    expectedResponse = undefined;
  }
}

function cleanupProtocol(send: CoverageProtocolRequest, initialError?: unknown): void {
  let error = initialError;
  for (const method of ['Profiler.stopPreciseCoverage', 'Profiler.disable', 'Debugger.disable']) {
    try {
      send(method, {});
    } catch (cleanupError) {
      error ??= cleanupError;
    }
  }
  if (error !== undefined) throw error;
}

/**
 * Create the CDP precise-coverage client.
 *
 * The injectable request function keeps protocol ordering, parameters, source
 * retrieval, and failure cleanup independently testable without duplicating
 * those rules in native code.
 *
 * @internal
 */
export function createCoverageProtocol(send: CoverageProtocolRequest): CoverageProtocol {
  return {
    start(): void {
      send('Debugger.enable', {});
      try {
        send('Profiler.enable', {});
        send('Profiler.startPreciseCoverage', {
          callCount: true,
          detailed: true,
          allowTriggeredUpdates: false,
        });
      } catch (error) {
        cleanupProtocol(send, error);
      }
    },
    take(): CoverageSnapshot {
      let snapshot: CoverageSnapshot | undefined;
      let error: unknown;
      try {
        const result = send('Profiler.takePreciseCoverage', {}) as PreciseCoverageResult;
        const sources: Record<string, string> = {};
        for (const script of result.result) {
          if (!script.url.startsWith('file://')) continue;
          const source = send('Debugger.getScriptSource', {
            scriptId: script.scriptId,
          }) as { scriptSource?: unknown };
          if (typeof source.scriptSource === 'string')
            sources[script.scriptId] = source.scriptSource;
        }
        snapshot = { ...result, sources };
      } catch (takeError) {
        error = takeError;
      }
      cleanupProtocol(send, error);
      return snapshot!;
    },
  };
}

const protocol = createCoverageProtocol(request);
let collecting = false;
let context: CoverageRealmContext | null = null;
let ownedRun: CoverageRunConfig | null = null;
let childSequence = 0;

function missingRealm(
  id: string,
  parentId: string | null,
  kind: string,
  entry: string | null,
): CoverageRealm {
  const metric = { covered: 0, total: 0, percent: 0 };
  return {
    id,
    parentId,
    kind,
    entry,
    status: 'missing',
    totals: { lines: { ...metric }, functions: { ...metric }, branches: { ...metric } },
  };
}

/** Create and register the bootstrap context for one child Realm. @internal */
export function createChildCoverageContext(
  kind: string,
  entry: string | null,
): CoverageRealmContext | undefined {
  if (context === null) return undefined;
  const child: CoverageRealmContext = {
    run: context.run,
    realm: missingRealm(`${context.realm.id}.${childSequence++}`, context.realm.id, kind, entry),
    toolVersion: context.toolVersion,
  };
  writeCoveragePlaceholderSync(child.run, child.realm);
  return child;
}

/** Start this Realm's inspector collector, adopting inherited bootstrap state. @internal */
export function startRealmCoverage(inherited?: CoverageRealmContext): void {
  if (collecting) return;
  if (inherited !== undefined) context = inherited;
  if (context === null) return;
  writeCoveragePlaceholderSync(context.run, context.realm);
  protocol.start();
  collecting = true;
}

/** Take, normalize, and publish the current Realm's final snapshot once. @internal */
export async function finishRealmCoverage(): Promise<void> {
  if (!collecting) return;
  collecting = false;
  const realmContext = context;
  context = null;
  if (realmContext === null) return;
  const snapshot = protocol.take();
  const { normalizeCoverageSnapshot, writeCoverageShard } = await import('internal:coverage/model');
  let shard;
  try {
    shard = await normalizeCoverageSnapshot(realmContext, snapshot);
  } catch (error) {
    shard = {
      realm: { ...realmContext.realm, status: 'missing' },
      files: [],
      warnings: [
        `unable to normalize coverage: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  await writeCoverageShard(realmContext.run, shard);
}

/** Start a test coverage run and its root-Realm collector. @internal */
export async function startCoverage(path: string): Promise<void> {
  const { prepareCoverageRun } = await import('internal:coverage/model');
  if (ownedRun !== null || context !== null) throw new Error('a coverage run is already active');
  const config = await prepareCoverageRun(path);
  ownedRun = config;
  context = {
    run: config,
    realm: missingRealm(`realm-${pid}-0`, null, 'test', null),
    toolVersion: runtimeVersion,
  };
  startRealmCoverage();
}

/** Finish the root Realm and return the aggregate run summary. @internal */
export async function finishCoverage(): Promise<CoverageSummary | null> {
  let collectionError: unknown;
  try {
    await finishRealmCoverage();
  } catch (error) {
    collectionError = error;
  }
  const run = ownedRun;
  ownedRun = null;
  let summary: CoverageSummary | null = null;
  let finalizationError: unknown;
  if (run !== null) {
    try {
      const { finishCoverageArtifact } = await import('internal:coverage/model');
      summary = await finishCoverageArtifact(run, runtimeVersion);
    } catch (error) {
      finalizationError = error;
    }
  }
  if (collectionError !== undefined) throw collectionError;
  if (finalizationError !== undefined) throw finalizationError;
  return summary;
}
