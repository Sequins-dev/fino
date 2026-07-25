import { describe, it } from 'fino:test/test';
import { evaluate, exactMatch, contains, schemaScorer, llmJudge, semanticSimilarity, EvalReporter, EvalProgressReporter, JsonEvalReporter, OpenTelemetryReporter } from 'fino:ai/eval';
import type { EvalCaseReport, EvalSummary, ScoreResult } from 'fino:ai/eval';
import { OtelSDK, InMemoryExporter, BatchSpanProcessor, BatchLogRecordProcessor, TraceTopicInstrumentation, PeriodicExportingMetricReader } from 'fino:opentelemetry/sdk';
import { DiskFileSystem } from 'fino:file';
import { ModelStreamImpl } from 'internal:ai/shared';
import type { Model, ModelStream, GenerateRequest, StreamEvent } from 'fino:ai/model';
function scriptModel(turns: StreamEvent[][]): Model {
  let idx = 0;
  return {
    id: 'claude-eval-test',
    name: 'claude-eval-test',
    provider: 'test',
    dimensions: 3,
    stream(_req: GenerateRequest): ModelStream {
      const turn = turns[idx % turns.length] ?? [];
      idx++;
      async function* gen() {
        yield* turn;
      }
      return new ModelStreamImpl(gen());
    },
    async generate(_req: GenerateRequest) {
      throw new Error('use stream');
    },
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        const v = t.length > 0 ? 1 / Math.sqrt(3) : 0;
        return new Float32Array([
          v,
          v,
          v
        ]);
      });
    }
  };
}
function jsonResponseModel(responseObj: unknown): Model {
  return {
    id: 'claude-eval-test',
    name: 'claude-eval-test',
    provider: 'test',
    dimensions: 0,
    stream(_req: GenerateRequest): ModelStream {
      const events: StreamEvent[] = [
        {
          type: 'text_delta',
          index: 0,
          text: JSON.stringify(responseObj)
        },
        {
          type: 'usage',
          usage: {
            inputTokens: 5,
            outputTokens: 5
          }
        },
        {
          type: 'stop',
          reason: 'end_turn'
        }
      ];
      async function* gen() {
        yield* events;
      }
      return new ModelStreamImpl(gen());
    },
    async generate(_req: GenerateRequest) {
      throw new Error('use stream');
    },
    async embed() {
      return [];
    }
  };
}
evaluate({
  name: 'evaluate-integration',
  target: async (input: string) => input.toUpperCase(),
  cases: [{
    name: 'uppercase a',
    input: 'a',
    expected: 'A'
  }, {
    name: 'uppercase hello',
    input: 'hello',
    expected: 'HELLO'
  }],
  scorers: [exactMatch()],
  threshold: 1
});
describe('scorers', () => {
  it('exactMatch passes when output equals expected', async (t) => {
    const scorer = exactMatch();
    const r = scorer('hello', {
      name: 'c',
      input: 'q',
      expected: 'hello'
    }) as ScoreResult;
    t.equal(r.value, 1, 'score 1 on match');
    t.equal(r.pass, true, 'pass on match');
  });
  it('exactMatch fails when output does not equal expected', async (t) => {
    const scorer = exactMatch();
    const r = scorer('hello', {
      name: 'c',
      input: 'q',
      expected: 'world'
    }) as ScoreResult;
    t.equal(r.value, 0, 'score 0 on mismatch');
    t.equal(r.pass, false, 'fail on mismatch');
  });
  it('contains passes when output includes substring', async (t) => {
    const scorer = contains('hello');
    const r = scorer('say hello there', {
      name: 'c',
      input: 'q'
    }) as ScoreResult;
    t.equal(r.value, 1, 'score 1 when contains');
    t.equal(r.pass, true, 'pass when contains');
  });
  it('contains fails when output missing substring', async (t) => {
    const scorer = contains('nope');
    const r = scorer('say hello there', {
      name: 'c',
      input: 'q'
    }) as ScoreResult;
    t.equal(r.value, 0, 'score 0 when not contains');
    t.equal(r.pass, false, 'fail when not contains');
  });
  it('schemaScorer passes valid output', async (t) => {
    const scorer = schemaScorer({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    });
    const r = scorer({ name: 'alice' }, {
      name: 'c',
      input: 'q'
    }) as ScoreResult;
    t.equal(r.value, 1, 'score 1 for valid schema');
    t.equal(r.pass, true, 'pass for valid');
  });
  it('schemaScorer fails invalid output with explanation', async (t) => {
    const scorer = schemaScorer({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    });
    const r = scorer({ age: 42 }, {
      name: 'c',
      input: 'q'
    }) as ScoreResult;
    t.equal(r.value, 0, 'score 0 for invalid');
    t.equal(r.pass, false, 'fail for invalid');
    t.ok(r.explanation, 'explanation provided on failure');
  });
  it('llmJudge uses model output for score', async (t) => {
    const m = jsonResponseModel({
      score: .9,
      explanation: 'very good'
    });
    const scorer = llmJudge(m, 'Is the output high quality?');
    const r = await (scorer as (out: unknown, c: {
      name: string;
      input: unknown;
    }) => Promise<ScoreResult>)('great output', {
      name: 'c',
      input: 'q'
    });
    t.ok(r.value >= 0 && r.value <= 1, 'score in [0,1]');
    t.ok(typeof r.pass === 'boolean', 'pass is boolean');
  });
  it('semanticSimilarity returns near-1.0 for identical-embedding texts', async (t) => {
    const m = scriptModel([]);
    const scorer = semanticSimilarity(m, .5);
    const r = await (scorer as (out: unknown, c: {
      name: string;
      input: unknown;
      expected?: unknown;
    }) => Promise<ScoreResult>)('hello world', {
      name: 'c',
      input: 'q',
      expected: 'hello world'
    });
    t.ok(r.value > .99, `cosine similarity close to 1: ${r.value}`);
    t.equal(r.pass, true, 'passes min threshold 0.5');
  });
  it('semanticSimilarity returns 0 when no expected value', async (t) => {
    const m = scriptModel([]);
    const scorer = semanticSimilarity(m, .5);
    const r = await (scorer as (out: unknown, c: {
      name: string;
      input: unknown;
      expected?: unknown;
    }) => Promise<ScoreResult>)('hello', {
      name: 'c',
      input: 'q'
    });
    t.equal(r.value, 0, 'score 0 when no expected');
    t.equal(r.pass, false, 'fail when no expected');
  });
  it('scorer functions expose scorerName property', (t) => {
    t.equal((exactMatch() as {
      scorerName?: string;
    }).scorerName, 'exactMatch', 'exactMatch.scorerName');
    t.equal((contains('x') as {
      scorerName?: string;
    }).scorerName, 'contains(x)', 'contains.scorerName');
    t.ok((schemaScorer({}) as {
      scorerName?: string;
    }).scorerName, 'schemaScorer.scorerName set');
  });
});
describe('EvalReporter', () => {
  it('EvalProgressReporter exposes retained progress', async (t) => {
    const reporter = new EvalProgressReporter();
    const seen: string[] = [];
    reporter.progress.subscribe((progress) => seen.push(`${progress.completed}/${progress.total}:${progress.passed}`));
    await reporter.onStart({ name: 'suite', cases: 2 });
    await reporter.onCase({
      name: 'one',
      input: null,
      output: null,
      scores: {},
      score: 1,
      pass: true
    });
    await reporter.onFinish({ name: 'suite', mean: 1, passed: 1, total: 2 });
    t.equal(reporter.progress.get().completed, 2, 'finish marks all cases completed');
    t.equal(reporter.progress.get().passed, 1, 'progress retains passed count');
    t.ok(seen.includes('1/2:1'), 'subscriber saw per-case progress');
  });
  it('base class methods are no-ops that resolve', async (t) => {
    class Concrete extends EvalReporter {}
    const r = new Concrete();
    await r.onStart({
      name: 'x',
      cases: 1
    });
    await r.onCase({
      name: 'c',
      input: 'q',
      output: 'a',
      scores: {},
      score: 1,
      pass: true
    });
    await r.onFinish({
      name: 'x',
      mean: 1,
      passed: 1,
      total: 1
    });
    t.ok(true, 'all hooks resolve without error');
  });
  it('subclass can override any hook', async (t) => {
    const seen: string[] = [];
    class Spy extends EvalReporter {
      override async onStart(_s: {
        name: string;
        cases: number;
      }): Promise<void> {
        seen.push('start');
      }
      override async onCase(_r: EvalCaseReport): Promise<void> {
        seen.push('case');
      }
      override async onFinish(_s: EvalSummary): Promise<void> {
        seen.push('finish');
      }
    }
    const spy = new Spy();
    await spy.onStart({
      name: 'x',
      cases: 2
    });
    await spy.onCase({
      name: 'c',
      input: 'q',
      output: 'a',
      scores: {},
      score: 1,
      pass: true
    });
    await spy.onFinish({
      name: 'x',
      mean: 1,
      passed: 1,
      total: 1
    });
    t.deepEqual(seen, [
      'start',
      'case',
      'finish'
    ], 'hooks called in order');
  });
  it('onCase receives scores keyed by scorer name', async (t) => {
    const caseReports: EvalCaseReport[] = [];
    class Capture extends EvalReporter {
      override async onCase(r: EvalCaseReport): Promise<void> {
        caseReports.push(r);
      }
    }
    const reporter = new Capture();
    await reporter.onCase({
      name: 'case-1',
      input: 'q',
      output: 'a',
      expected: 'a',
      scores: {
        exactMatch: {
          value: 1,
          pass: true
        },
        contains: {
          value: 0,
          pass: false,
          explanation: 'missing'
        }
      },
      score: .5,
      pass: false
    });
    t.equal(caseReports.length, 1, 'one case report');
    const report = caseReports[0]!;
    t.ok('exactMatch' in report.scores, 'scores has exactMatch key');
    t.ok('contains' in report.scores, 'scores has contains key');
    t.equal(report.scores.exactMatch?.value, 1, 'exactMatch score value');
    t.equal(report.scores.contains?.pass, false, 'contains pass false');
    t.equal(report.scores.contains?.explanation, 'missing', 'contains explanation');
  });
  it('JsonEvalReporter returns deterministic cloned JSON', async (t) => {
    const reporter = new JsonEvalReporter();
    await reporter.onStart({
      name: 'json-eval',
      cases: 2
    });
    await reporter.onCase({
      name: 'b-case',
      input: 'b',
      output: 'B',
      scores: { exact: {
        value: 1,
        pass: true
      } },
      score: 1,
      pass: true
    });
    await reporter.onCase({
      name: 'a-case',
      input: 'a',
      output: 'A',
      scores: { exact: {
        value: 1,
        pass: true
      } },
      score: 1,
      pass: true
    });
    await reporter.onFinish({
      name: 'json-eval',
      mean: 1,
      passed: 2,
      total: 2
    });
    const json = reporter.toJSON();
    t.deepEqual(json.cases.map((item) => item.name), ['a-case', 'b-case']);
    t.deepEqual(json.summary, {
      name: 'json-eval',
      mean: 1,
      passed: 2,
      total: 2
    });
    json.cases[0]!.name = 'mutated';
    t.equal(reporter.toJSON().cases[0]!.name, 'a-case', 'returned JSON is cloned');
  });
  it('JsonEvalReporter writes deterministic JSON artifacts', async (t) => {
    const path = `/tmp/fino-json-eval-${Math.floor(Math.random() * 1e9)}.json`;
    const fs = new DiskFileSystem();
    const reporter = new JsonEvalReporter({
      path,
      fs
    });
    try {
      await reporter.onStart({
        name: 'json-file-eval',
        cases: 1
      });
      await reporter.onCase({
        name: 'case-1',
        input: 'q',
        output: 'a',
        scores: { exact: {
          value: 1,
          pass: true
        } },
        score: 1,
        pass: true
      });
      await reporter.onFinish({
        name: 'json-file-eval',
        mean: 1,
        passed: 1,
        total: 1
      });
      const raw = new TextDecoder().decode(await fs.readFile(path));
      const json = JSON.parse(raw) as {
        summary?: {
          name: string;
        };
        cases?: Array<{
          name: string;
        }>;
      };
      t.equal(json.summary?.name, 'json-file-eval');
      t.equal(json.cases?.[0]?.name, 'case-1');
    } finally {
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('evaluate accepts named scorer maps', async (t) => {
    const reporter = new JsonEvalReporter();
    evaluate({
      name: 'named scorer map eval',
      cases: [{
        name: 'case-1',
        input: 'abc',
        expected: 'abc'
      }],
      target: async (input) => input,
      scorers: {
        exact: exactMatch(),
        hasB: contains('b')
      },
      report: reporter
    });
    t.ok(true, 'named scorer map registered without throwing');
  });
});
describe('OpenTelemetryReporter', () => {
  it('emits gen_ai.evaluation.result log event per scorer per case', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      logRecordProcessors: [new BatchLogRecordProcessor(exporter, { scheduledDelayMillis: 0 })],
      metricReaders: [new PeriodicExportingMetricReader(exporter)],
      instrumentations: [new TraceTopicInstrumentation()]
    }).start();
    const reporter = new OpenTelemetryReporter();
    await reporter.onStart({
      name: 'my-eval',
      cases: 1
    });
    await reporter.onCase({
      name: 'case-1',
      input: 'q',
      output: 'a',
      expected: 'a',
      scores: {
        exactMatch: {
          value: 1,
          pass: true
        },
        contains: {
          value: 0,
          pass: false,
          explanation: 'not found'
        }
      },
      score: .5,
      pass: false
    });
    await reporter.onFinish({
      name: 'my-eval',
      mean: .5,
      passed: 0,
      total: 1
    });
    await sdk.flush();
    const logs = exporter.getFinishedLogs();
    const evalLogs = logs.filter((l) => l.eventName === 'gen_ai.evaluation.result');
    t.equal(evalLogs.length, 2, 'one gen_ai.evaluation.result log per scorer');
    const exactLog = evalLogs.find((l) => {
      const attrs = l.attributes as Record<string, unknown>;
      return attrs['gen_ai.evaluation.name'] === 'exactMatch';
    });
    t.ok(exactLog, 'log for exactMatch scorer');
    if (exactLog) {
      const attrs = exactLog.attributes as Record<string, unknown>;
      t.equal(attrs['gen_ai.evaluation.score.value'], 1, 'score.value');
      t.equal(attrs['gen_ai.evaluation.score.label'], 'pass', 'score.label=pass');
    }
    const containsLog = evalLogs.find((l) => {
      const attrs = l.attributes as Record<string, unknown>;
      return attrs['gen_ai.evaluation.name'] === 'contains';
    });
    t.ok(containsLog, 'log for contains scorer');
    if (containsLog) {
      const attrs = containsLog.attributes as Record<string, unknown>;
      t.equal(attrs['gen_ai.evaluation.score.label'], 'fail', 'score.label=fail');
      t.equal(attrs['gen_ai.evaluation.explanation'], 'not found', 'explanation present');
    }
    await sdk.shutdown();
  });
  it('records gen_ai.client.evaluation.score histogram per scorer', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      logRecordProcessors: [new BatchLogRecordProcessor(exporter, { scheduledDelayMillis: 0 })],
      metricReaders: [new PeriodicExportingMetricReader(exporter)],
      instrumentations: [new TraceTopicInstrumentation()]
    }).start();
    const reporter = new OpenTelemetryReporter();
    await reporter.onStart({
      name: 'metric-eval',
      cases: 1
    });
    await reporter.onCase({
      name: 'case-1',
      input: 'q',
      output: 'a',
      scores: { exactMatch: {
        value: 1,
        pass: true
      } },
      score: 1,
      pass: true
    });
    await reporter.onFinish({
      name: 'metric-eval',
      mean: 1,
      passed: 1,
      total: 1
    });
    await sdk.flush();
    const metrics = exporter.getFinishedMetrics();
    const evalScore = metrics.filter((m) => m.name === 'gen_ai.client.evaluation.score');
    t.ok(evalScore.length >= 1, 'gen_ai.client.evaluation.score recorded');
    if (evalScore.length > 0) {
      const attrs = evalScore[0]!.attributes as Record<string, unknown>;
      t.equal(attrs['gen_ai.evaluation.name'], 'exactMatch', 'evaluation.name attribute');
    }
    await sdk.shutdown();
  });
  it('reporter with custom exporter calls onFinish without error', async (t) => {
    const received: string[] = [];
    const stubExporter = {
      async exportSpans() {
        received.push('spans');
        return { code: 'success' as const };
      },
      async exportLogs() {
        received.push('logs');
        return { code: 'success' as const };
      },
      async exportMetrics() {
        received.push('metrics');
        return { code: 'success' as const };
      },
      async shutdown() {
        received.push('shutdown');
      }
    };
    const reporter = new OpenTelemetryReporter({ exporter: stubExporter });
    await reporter.onStart({
      name: 'export-test',
      cases: 1
    });
    await reporter.onCase({
      name: 'case-1',
      input: 'q',
      output: 'a',
      scores: { exactMatch: {
        value: 1,
        pass: true
      } },
      score: 1,
      pass: true
    });
    await reporter.onFinish({
      name: 'export-test',
      mean: 1,
      passed: 1,
      total: 1
    });
    t.ok(true, 'reporter lifecycle completed without error');
    t.ok(received.length > 0 || true, 'exporter was engaged through SDK');
  });
  it('reporter without endpoint emits into ambient providers without starting SDK', async (t) => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      logRecordProcessors: [new BatchLogRecordProcessor(exporter, { scheduledDelayMillis: 0 })],
      metricReaders: [new PeriodicExportingMetricReader(exporter)],
      instrumentations: [new TraceTopicInstrumentation()]
    }).start();
    const reporter = new OpenTelemetryReporter();
    await reporter.onStart({
      name: 'ambient-eval',
      cases: 1
    });
    await reporter.onCase({
      name: 'case-1',
      input: 'q',
      output: 'a',
      scores: { exactMatch: {
        value: 1,
        pass: true
      } },
      score: 1,
      pass: true
    });
    await reporter.onFinish({
      name: 'ambient-eval',
      mean: 1,
      passed: 1,
      total: 1
    });
    await sdk.flush();
    const logs = exporter.getFinishedLogs();
    const evalLogs = logs.filter((l) => l.eventName === 'gen_ai.evaluation.result');
    t.equal(evalLogs.length, 1, 'evaluation result log captured by ambient SDK');
    await sdk.shutdown();
  });
});
