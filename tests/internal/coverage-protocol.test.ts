import { describe, it } from 'fino:test/test';
import { createCoverageProtocol, type CoverageProtocolRequest } from 'internal:coverage';

interface Call {
  method: string;
  params: object;
}

describe('coverage inspector protocol', () => {
  it('uses precise block coverage and fetches only filesystem sources', (t) => {
    const calls: Call[] = [];
    const request: CoverageProtocolRequest = (method, params) => {
      calls.push({ method, params });
      if (method === 'Profiler.takePreciseCoverage') {
        return {
          result: [
            { scriptId: '12', url: 'file:///project/source.ts', functions: [] },
            { scriptId: '13', url: 'internal:bootstrap', functions: [] },
          ],
          timestamp: 42,
        };
      }
      if (method === 'Debugger.getScriptSource') return { scriptSource: 'export const value = 1;' };
      return {};
    };
    const protocol = createCoverageProtocol(request);
    protocol.start();
    const snapshot = protocol.take();

    t.deepEqual(
      calls.map((call) => call.method),
      [
        'Debugger.enable',
        'Profiler.enable',
        'Profiler.startPreciseCoverage',
        'Profiler.takePreciseCoverage',
        'Debugger.getScriptSource',
        'Profiler.stopPreciseCoverage',
        'Profiler.disable',
        'Debugger.disable',
      ],
      'collector follows the CDP lifecycle in order',
    );
    t.deepEqual(
      calls[2]?.params,
      { callCount: true, detailed: true, allowTriggeredUpdates: false },
      'precise coverage retains counts and detailed block ranges',
    );
    t.deepEqual(
      calls[4]?.params,
      { scriptId: '12' },
      'source retrieval is keyed by the covered filesystem script id',
    );
    t.deepEqual(
      snapshot.sources,
      { '12': 'export const value = 1;' },
      'snapshot attaches generated source text for native offset normalization',
    );
  });

  it('disables profiler and debugger domains when source retrieval fails', (t) => {
    const calls: string[] = [];
    const protocol = createCoverageProtocol((method) => {
      calls.push(method);
      if (method === 'Profiler.takePreciseCoverage') {
        return {
          result: [{ scriptId: '7', url: 'file:///project/failure.ts', functions: [] }],
        };
      }
      if (method === 'Debugger.getScriptSource') throw new Error('source retrieval failed');
      return {};
    });

    t.throws(() => protocol.take(), /source retrieval failed/, 'original collection error is kept');
    t.deepEqual(
      calls,
      [
        'Profiler.takePreciseCoverage',
        'Debugger.getScriptSource',
        'Profiler.stopPreciseCoverage',
        'Profiler.disable',
        'Debugger.disable',
      ],
      'all enabled domains are cleaned up after failure',
    );
  });

  it('cleans up partial protocol setup without replacing the start error', (t) => {
    const calls: string[] = [];
    const protocol = createCoverageProtocol((method) => {
      calls.push(method);
      if (method === 'Profiler.startPreciseCoverage') throw new Error('start failed');
      if (method === 'Profiler.stopPreciseCoverage') throw new Error('stop failed');
      return {};
    });

    t.throws(() => protocol.start(), /start failed/, 'start failure remains primary');
    t.deepEqual(
      calls,
      [
        'Debugger.enable',
        'Profiler.enable',
        'Profiler.startPreciseCoverage',
        'Profiler.stopPreciseCoverage',
        'Profiler.disable',
        'Debugger.disable',
      ],
      'partial setup still runs every cleanup request',
    );
  });
});
