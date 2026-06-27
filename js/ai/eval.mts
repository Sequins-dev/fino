/**
 * Lightweight evaluation harness for AI workflows.
 *
 * `evaluate()` registers test cases with the Fino test runner and records
 * scorer output. Built-in scorers cover exact/contains/schema checks and
 * model-assisted judging while reporters provide integration points for
 * telemetry or custom result sinks.
 */

import { suite, test } from 'fino:test/test';
import type { Model } from 'fino:ai/model';
import { compile } from 'fino:validate';
import { agent } from 'fino:ai/agent';
import { OtelSDK, BatchSpanProcessor, TraceTopicInstrumentation, PeriodicExportingMetricReader, OTLPHttpJsonExporter } from 'fino:opentelemetry/sdk';
import type { Resource } from 'fino:opentelemetry/sdk';
import { getLoggerProvider, LogRecordBuilder, SeverityNumber } from 'fino:opentelemetry/logs';
import { getMeterProvider } from 'fino:opentelemetry/metrics';

/**
 * One evaluation case.
 */
export interface EvalCase<In = unknown, Out = unknown> {
  name: string;
  input: In;
  expected?: Out;
  [key: string]: unknown;
}

/**
 * Result produced by a scorer.
 */
export interface ScoreResult {
  value: number;
  pass: boolean;
  explanation?: string;
}

/**
 * Function that scores one evaluation output.
 */
export type Scorer<Out = unknown> = (
  output: Out,
  evalCase: EvalCase<unknown, Out>,
) => number | ScoreResult | Promise<number | ScoreResult>;

/**
 * Report for one evaluated case.
 */
export interface EvalCaseReport<In = unknown, Out = unknown> {
  name: string;
  input: In;
  output: Out;
  expected?: Out;
  conversationId?: string;
  responseId?: string;
  scores: Record<string, ScoreResult>;
  score: number;
  pass: boolean;
}

/**
 * Aggregate report for an evaluation suite.
 */
export interface EvalSummary {
  name: string;
  mean: number;
  passed: number;
  total: number;
}

/**
 * Receives per-case and summary evaluation reports.
 */
export abstract class EvalReporter {
  async onStart(_suite: { name: string; cases: number }): Promise<void> {}
  async onCase(_r: EvalCaseReport): Promise<void> {}
  async onFinish(_summary: EvalSummary): Promise<void> {}
}

/**
 * Options for `evaluate()`.
 */
export interface EvalOptions<In = unknown, Out = unknown> {
  name: string;
  target: (input: In) => Promise<Out>;
  cases: EvalCase<In, Out>[];
  scorers: Scorer<Out>[];
  threshold?: number;
  report?: EvalReporter;
}

function normalizeScoreResult(raw: number | ScoreResult, threshold: number): ScoreResult {
  if (typeof raw === 'number') {
    return { value: raw, pass: raw >= threshold };
  }
  return { value: raw.value, pass: raw.pass, explanation: raw.explanation };
}

/**
 * Register an evaluation suite with the Fino test runner.
 */
export function evaluate<In = unknown, Out = unknown>(opts: EvalOptions<In, Out>): void {
  const { name, target, cases, scorers, threshold = 1.0, report } = opts;
  const allScores: number[] = [];
  let passedCount = 0;
  let startCalled = false;

  suite(name, () => {
    for (const c of cases) {
      test(c.name, async (t) => {
        if (!startCalled) {
          startCalled = true;
          await report?.onStart({ name, cases: cases.length });
        }

        const output = await target(c.input);
        const scorerResults: Record<string, ScoreResult> = {};
        const scoreValues: number[] = [];

        for (const scorer of scorers) {
          const scorerName = (scorer as { scorerName?: string }).scorerName ?? scorer.name ?? 'scorer';
          const raw = await scorer(output, c as EvalCase<unknown, Out>);
          const sr = normalizeScoreResult(raw, threshold);
          scorerResults[scorerName] = sr;
          scoreValues.push(sr.value);
        }

        const meanScore = scoreValues.length > 0
          ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length
          : 1;
        const passes = meanScore >= threshold;

        allScores.push(meanScore);
        if (passes) passedCount++;

        t.meta({ score: meanScore });
        t.ok(passes, `score ${meanScore.toFixed(3)} >= threshold ${threshold}`);

        await report?.onCase({
          name: c.name,
          input: c.input as unknown,
          output: output as unknown,
          expected: c.expected as unknown,
          scores: scorerResults,
          score: meanScore,
          pass: passes,
        });
      });
    }

    test('summary', async (t) => {
      const mean = allScores.length > 0
        ? allScores.reduce((a, b) => a + b, 0) / allScores.length
        : 1;
      const passes = mean >= threshold;
      t.meta({ mean: mean.toFixed(3), passed: passedCount, total: cases.length });
      t.ok(passes, `mean score ${mean.toFixed(3)} >= threshold ${threshold}`);

      await report?.onFinish({ name, mean, passed: passedCount, total: cases.length });
    });
  });
}

/**
 * Score exact string equality.
 */
export function exactMatch(): Scorer {
  const fn = (output: unknown, c: EvalCase): ScoreResult => {
    const pass = JSON.stringify(output) === JSON.stringify(c.expected);
    return { value: pass ? 1 : 0, pass };
  };
  (fn as { scorerName?: string }).scorerName = 'exactMatch';
  return fn;
}

/**
 * Score whether the output text contains `substr`.
 */
export function contains(substr: string): Scorer {
  const fn = (output: unknown): ScoreResult => {
    const str = typeof output === 'string' ? output : JSON.stringify(output);
    const pass = str.includes(substr);
    return { value: pass ? 1 : 0, pass };
  };
  (fn as { scorerName?: string }).scorerName = `contains(${substr})`;
  return fn;
}

/**
 * Score whether the output validates against a schema.
 */
export function schemaScorer(schema: unknown): Scorer {
  const compiled = compile(schema as Record<string, unknown>);
  const fn = (output: unknown): ScoreResult => {
    const r = compiled.safeParse(output);
    const pass = r.success;
    const explanation = pass
      ? undefined
      : r.issues?.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join('; ');
    return { value: pass ? 1 : 0, pass, explanation };
  };
  (fn as { scorerName?: string }).scorerName = 'schemaScorer';
  return fn;
}

/**
 * Score output with a model using a rubric.
 */
export function llmJudge(model: Model, rubric: string): Scorer {
  const judgeAgent = agent({ model });

  const fn = async (output: unknown, c: EvalCase): Promise<ScoreResult> => {
    const prompt = [
      `Rubric: ${rubric}`,
      `Input: ${JSON.stringify(c.input)}`,
      `Expected: ${c.expected !== undefined ? JSON.stringify(c.expected) : 'none'}`,
      `Output: ${JSON.stringify(output)}`,
      'Score from 0 to 1. Respond with ONLY valid JSON: {"score": 0.0, "explanation": "..."}',
    ].join('\n');

    const result = await judgeAgent.generate(prompt);
    let obj: { score?: number; explanation?: string } | undefined;
    try {
      obj = JSON.parse(result.text) as typeof obj;
    } catch {
      obj = undefined;
    }
    const value = Math.max(0, Math.min(1, obj?.score ?? 0));
    return { value, pass: value >= 1, explanation: obj?.explanation };
  };
  (fn as { scorerName?: string }).scorerName = 'llmJudge';
  return fn;
}

/**
 * Score output by embedding similarity against the expected value.
 */
export function semanticSimilarity(model: Model, min: number): Scorer {
  const fn = async (output: unknown, c: EvalCase): Promise<ScoreResult> => {
    const outStr = typeof output === 'string' ? output : JSON.stringify(output);
    const expStr = c.expected !== undefined
      ? (typeof c.expected === 'string' ? c.expected : JSON.stringify(c.expected))
      : '';
    if (!expStr) return { value: 0, pass: false, explanation: 'no expected value' };

    const [outEmb, expEmb] = await model.embed([outStr, expStr]);
    if (!outEmb || !expEmb) return { value: 0, pass: false };

    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < outEmb.length; i++) {
      dot += outEmb[i]! * expEmb[i]!;
      normA += outEmb[i]! * outEmb[i]!;
      normB += expEmb[i]! * expEmb[i]!;
    }
    const cosine = normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
    const pass = cosine >= min;
    return { value: cosine, pass, explanation: `cosine similarity ${cosine.toFixed(4)}` };
  };
  (fn as { scorerName?: string }).scorerName = `semanticSimilarity(${min})`;
  return fn;
}

/**
 * Options for `OpenTelemetryReporter`.
 */
export interface OpenTelemetryReporterOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  exporter?: unknown;
  resource?: Resource;
}

/**
 * Eval reporter that emits OpenTelemetry spans.
 */
export class OpenTelemetryReporter extends EvalReporter {
  #opts: OpenTelemetryReporterOptions;
  #sdk: OtelSDK | undefined;

  constructor(opts: OpenTelemetryReporterOptions = {}) {
    super();
    this.#opts = opts;
  }

  async onStart(suite: { name: string; cases: number }): Promise<void> {
    const exp = this.#opts.exporter ?? (this.#opts.endpoint
      ? new OTLPHttpJsonExporter({ endpoint: this.#opts.endpoint, headers: this.#opts.headers })
      : undefined);

    if (exp) {
      const sdkOpts: Record<string, unknown> = {
        spanProcessors: [new BatchSpanProcessor(exp as never, { scheduledDelayMillis: 0 })],
        instrumentations: [new TraceTopicInstrumentation()],
        exporters: [exp],
        metricReaders: [new PeriodicExportingMetricReader(exp as never)],
      };
      if (this.#opts.resource) sdkOpts['resource'] = this.#opts.resource;
      this.#sdk = new OtelSDK(sdkOpts).start();
    }

    void suite;
  }

  async onCase(r: EvalCaseReport): Promise<void> {
    const logger = getLoggerProvider().getLogger('fino.ai.eval');
    const meter = getMeterProvider().getMeter('fino.ai.eval');
    const evalScoreHist = meter.createHistogram('gen_ai.client.evaluation.score', {
      unit: '1',
      description: 'GenAI evaluation score',
    });

    for (const [scorerName, sr] of Object.entries(r.scores)) {
      const attrs: Record<string, unknown> = {
        'gen_ai.evaluation.name': scorerName,
      };
      if (r.conversationId) attrs['gen_ai.conversation.id'] = r.conversationId;
      if (r.responseId) attrs['gen_ai.response.id'] = r.responseId;

      evalScoreHist.record(sr.value, attrs);

      logger.emitRecord(
        new LogRecordBuilder()
          .setEventName('gen_ai.evaluation.result')
          .setSeverity('INFO', SeverityNumber.INFO)
          .setAttributes({
            ...attrs,
            'gen_ai.evaluation.score.value': sr.value,
            'gen_ai.evaluation.score.label': sr.pass ? 'pass' : 'fail',
            ...(sr.explanation ? { 'gen_ai.evaluation.explanation': sr.explanation } : {}),
          }),
      );
    }
  }

  async onFinish(_summary: EvalSummary): Promise<void> {
    if (this.#sdk) {
      await this.#sdk.flush();
      await this.#sdk.shutdown();
      this.#sdk = undefined;
    }
  }
}
