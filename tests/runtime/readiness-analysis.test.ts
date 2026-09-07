import { describe, it } from 'fino:test/test';
import { analyzeReadiness } from '../../js/internal/scheduler/readiness-analysis.ts';

describe('Readiness trace analysis', () => {
  it('keeps a stranded registration visible beside completed traffic', (t) => {
    const event = (operation, stage, sequence) => ({
      operation,
      stage,
      sequence,
      owner: 3,
      ident: 8,
      filter: -1,
      token: 8,
      elapsed_us: sequence,
    });
    const analysis = analyzeReadiness({
      version: 1,
      enabled: true,
      capacity: 8,
      sequence: 5,
      dropped: 0,
      events: [
        event(1, 'registered', 1),
        event(1, 'controller-received', 2),
        event(2, 'registered', 3),
        event(2, 'routed', 4),
        event(2, 'resolved', 5),
      ],
    });
    t.deepEqual(
      analysis.pending.map((item) => item.operation),
      [1],
    );
    t.equal(analysis.pending[0].lastStage, 'controller-received');
    t.equal(analysis.incompleteHistory, false);
  });
  it('reports incomplete history and preserves mismatch evidence after resolution', (t) => {
    const events = ['resolver-generation-mismatch', 'resolved'].map((stage, index) => ({
      operation: 8,
      stage,
      sequence: index + 3,
      owner: 4,
      ident: 8,
      filter: -1,
      token: 8,
      elapsed_us: index,
    }));
    const analysis = analyzeReadiness({
      version: 1,
      enabled: true,
      capacity: 2,
      sequence: 4,
      dropped: 2,
      events,
    });
    t.equal(analysis.incompleteHistory, true);
    t.equal(analysis.pending.length, 0);
    t.equal(analysis.anomalies[0].stage, 'resolver-generation-mismatch');
  });
});
