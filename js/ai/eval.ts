/**
 * fino:ai/eval — evaluation cases, scorers, and reporters for AI behavior.
 *
 * This module runs AI evaluations inside the Fino test runner. `evaluate()`
 * registers one test per case plus a trailing `summary` test, executes an
 * application-supplied `target` function on each case input, scores every
 * output, and asserts that scores clear a threshold. Use it for regression
 * checks around prompts, tool behavior, workflows, retrieval, and provider
 * migrations.
 *
 * ## Scoring model
 *
 * A scorer receives the target's output plus the full case and returns either
 * a bare number or a `ScoreResult` with pass/explanation metadata. A case's
 * score is the mean of its scorer values, and the case passes when that mean
 * reaches the threshold (default `1`, meaning every scorer must be perfect).
 * Built-ins cover exact matches (`exactMatch`), substring checks (`contains`),
 * schema validation (`schemaScorer`), model-assisted rubric judging
 * (`llmJudge`), and embedding similarity (`semanticSimilarity`).
 *
 * Reporters are optional sinks layered on top of the test results:
 * `JsonEvalReporter` retains a deterministic JSON artifact,
 * `EvalProgressReporter` publishes live progress as a signal, and
 * `OpenTelemetryReporter` emits GenAI-semconv logs and metrics without
 * changing the test result semantics.
 *
 * Evaluations are still tests. Keep cases deterministic where possible, pin or
 * stub models for CI, and treat LLM-judged scores as a policy choice rather
 * than a correctness oracle. Case arrays are snapshotted into the shared
 * `Dataset` contract; callers with an existing finite `Dataset` can reuse it
 * directly.
 *
 * ```ts no_run
 * import { contains, evaluate } from 'fino:ai/eval';
 *
 * evaluate({
 *   name: 'support answer',
 *   cases: [{ name: 'refund policy', input: 'refund window?', expected: '30 days' }],
 *   target: async (input) => askSupportBot(input),
 *   scorers: { mentionsWindow: contains('30 days') },
 * });
 * ```
 *
 * GenAI telemetry conventions:
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
import { suite, test } from 'fino:test/test';
import type { EmbeddingModel, Model } from 'fino:ai/model';
import { compile } from 'fino:validate';
import { agent } from 'fino:ai/agent';
import {
  OtelSDK,
  BatchSpanProcessor,
  TraceTopicInstrumentation,
  PeriodicExportingMetricReader,
  OTLPHttpJsonExporter,
} from 'fino:opentelemetry/sdk';
import type { Resource } from 'fino:opentelemetry/sdk';
import { getLoggerProvider, LogRecordBuilder, SeverityNumber } from 'fino:opentelemetry/logs';
import { getMeterProvider } from 'fino:opentelemetry/metrics';
import { createSignal } from 'fino:signals';
import type { ReadonlySignal } from 'fino:signals';
import { Dataset } from 'fino:data/dataset';
import { cosineSimilarity, StreamingMean } from 'fino:ml/metrics';
/**
 * One evaluation case: a named input plus an optional expected output.
 *
 * `name` becomes the test name inside the suite that `evaluate()` registers.
 * `expected` feeds scorers that compare against a reference value
 * (`exactMatch`, `semanticSimilarity`, `llmJudge`); scorers that only inspect
 * the output ignore it. Extra properties are allowed and travel with the case
 * into every scorer, so metadata such as tags or difficulty can inform custom
 * scorers.
 *
 * ```ts no_run
 * import type { EvalCase } from 'fino:ai/eval';
 *
 * const c: EvalCase<string, string> = {
 *   name: 'refund policy',
 *   input: 'What is the refund window?',
 *   expected: '30 days',
 *   difficulty: 'easy',
 * };
 * ```
 */
export interface EvalCase<In = unknown, Out = unknown> {
  /**
   * Test name for this case within the evaluation suite.
   */
  name: string;
  /**
   * Value passed to the evaluation's `target` function.
   */
  input: In;
  /**
   * Reference output for scorers that compare against an expected value.
   */
  expected?: Out;
  /**
   * Additional case metadata, visible to every scorer.
   */
  [key: string]: unknown;
}
/**
 * Result produced by a scorer for one case.
 *
 * `value` is the numeric score, conventionally in `[0, 1]`. `pass` records the
 * scorer's own verdict, but `evaluate()` decides case pass/fail from the mean
 * of scorer values against its threshold — the per-scorer flag is reporting
 * metadata, not the test assertion.
 *
 * ```ts no_run
 * import type { ScoreResult } from 'fino:ai/eval';
 *
 * const result: ScoreResult = {
 *   value: 0.5,
 *   pass: false,
 *   explanation: 'answer omitted the refund window',
 * };
 * ```
 */
export interface ScoreResult {
  /**
   * Numeric score, conventionally in `[0, 1]`.
   */
  value: number;
  /**
   * The scorer's own pass/fail verdict for this output.
   */
  pass: boolean;
  /**
   * Optional human-readable reason for the score, surfaced in reports.
   */
  explanation?: string;
}
/**
 * Function that scores one evaluation output.
 *
 * Receives the target's output and the full case (including `expected` and any
 * extra metadata). It may return a bare number — which `evaluate()` normalizes
 * into a `ScoreResult` whose `pass` is `value >= threshold` — or a complete
 * `ScoreResult`, synchronously or as a promise. A scorer that throws fails the
 * case's test outright.
 *
 * When scorers are passed to `evaluate()` as an array, the reported scorer
 * name comes from a `scorerName` property on the function (all built-ins set
 * one), falling back to the function's `name`. Passing a
 * `Record<string, Scorer>` names each scorer by its key instead.
 *
 * ```ts no_run
 * import type { Scorer } from 'fino:ai/eval';
 *
 * const noApologies: Scorer<string> = (output) => ({
 *   value: output.includes('sorry') ? 0 : 1,
 *   pass: !output.includes('sorry'),
 *   explanation: 'responses should not apologize',
 * });
 * ```
 */
export type Scorer<Out = unknown> = (
  output: Out,
  evalCase: EvalCase<unknown, Out>,
) => number | ScoreResult | Promise<number | ScoreResult>;
/**
 * Report for one evaluated case, delivered to `EvalReporter.onCase()`.
 *
 * `scores` is keyed by scorer name and holds each scorer's normalized result;
 * `score` is the mean of those values and `pass` records whether the mean
 * reached the evaluation threshold.
 *
 * ```ts no_run
 * import { EvalReporter, type EvalCaseReport } from 'fino:ai/eval';
 *
 * class FailureLogger extends EvalReporter {
 *   override async onCase(r: EvalCaseReport): Promise<void> {
 *     if (!r.pass) console.log(`${r.name} scored ${r.score}`, r.scores);
 *   }
 * }
 * ```
 */
export interface EvalCaseReport<In = unknown, Out = unknown> {
  /**
   * Case name, as declared in `EvalCase.name`.
   */
  name: string;
  /**
   * Input the target function was called with.
   */
  input: In;
  /**
   * Value the target function returned for this case.
   */
  output: Out;
  /**
   * Reference output from the case, when one was declared.
   */
  expected?: Out;
  /**
   * Optional conversation correlation id. `evaluate()` does not populate it;
   * custom reporters or pipelines may. The OpenTelemetry reporter maps it to
   * the `gen_ai.conversation.id` attribute.
   */
  conversationId?: string;
  /**
   * Optional model response correlation id, mapped to `gen_ai.response.id` by
   * the OpenTelemetry reporter. Not populated by `evaluate()` itself.
   */
  responseId?: string;
  /**
   * Normalized result of each scorer, keyed by scorer name.
   */
  scores: Record<string, ScoreResult>;
  /**
   * Mean of the scorer values for this case.
   */
  score: number;
  /**
   * Whether the mean score reached the evaluation threshold.
   */
  pass: boolean;
}
/**
 * Aggregate result for an evaluation suite, delivered to `onFinish()`.
 *
 * `mean` averages the per-case mean scores, `passed` counts cases whose score
 * cleared the threshold, and `total` is the number of cases in the suite.
 *
 * ```ts no_run
 * import { EvalReporter, type EvalSummary } from 'fino:ai/eval';
 *
 * class SummaryLogger extends EvalReporter {
 *   override async onFinish(s: EvalSummary): Promise<void> {
 *     console.log(`${s.name}: ${s.passed}/${s.total} passed, mean ${s.mean.toFixed(3)}`);
 *   }
 * }
 * ```
 */
export interface EvalSummary {
  /**
   * Name of the evaluation suite.
   */
  name: string;
  /**
   * Mean of all per-case scores.
   */
  mean: number;
  /**
   * Number of cases whose score reached the threshold.
   */
  passed: number;
  /**
   * Total number of cases in the suite.
   */
  total: number;
}
/**
 * Snapshot of evaluation progress published by `EvalProgressReporter`.
 *
 * `completed` counts cases scored so far, `passed` counts those that cleared
 * the threshold, and `mean` is the running average score over completed
 * cases. After the suite finishes, the snapshot matches the final summary
 * with `completed` equal to `total`.
 *
 * ```ts no_run
 * import { EvalProgressReporter, type EvalProgress } from 'fino:ai/eval';
 *
 * const reporter = new EvalProgressReporter();
 * reporter.progress.subscribe((p: EvalProgress) => {
 *   console.log(`${p.completed}/${p.total} done, mean ${p.mean.toFixed(3)}`);
 * });
 * ```
 */
export interface EvalProgress {
  /**
   * Name of the evaluation suite, empty until `onStart()` fires.
   */
  name: string;
  /**
   * Number of completed cases that passed so far.
   */
  passed: number;
  /**
   * Total number of cases in the suite.
   */
  total: number;
  /**
   * Number of cases scored so far.
   */
  completed: number;
  /**
   * Running mean score over completed cases.
   */
  mean: number;
}
/**
 * JSON-serializable evaluation report produced by `JsonEvalReporter.toJSON()`.
 *
 * `suite` appears once `onStart()` has fired and `summary` once `onFinish()`
 * has; `cases` is always present and sorted by case name so serialized
 * reports diff cleanly between runs.
 *
 * ```ts no_run
 * import { JsonEvalReporter, type JsonEvalReport } from 'fino:ai/eval';
 *
 * const reporter = new JsonEvalReporter();
 * // ... run an evaluation with `report: reporter` ...
 * const report: JsonEvalReport = reporter.toJSON();
 * console.log(report.summary?.mean, report.cases.length);
 * ```
 */
export interface JsonEvalReport {
  /**
   * Suite name and case count, present once the run has started.
   */
  suite?: {
    name: string;
    cases: number;
  };
  /**
   * Per-case reports, sorted by case name.
   */
  cases: EvalCaseReport[];
  /**
   * Aggregate result, present once the run has finished.
   */
  summary?: EvalSummary;
}
/**
 * Options for `JsonEvalReporter`.
 *
 * File output only happens when both `path` and `fs` are provided; otherwise
 * the report is available in memory through `toJSON()`.
 *
 * ```ts no_run
 * import { JsonEvalReporter } from 'fino:ai/eval';
 * import { DiskFileSystem } from 'fino:file';
 *
 * const reporter = new JsonEvalReporter({
 *   path: './eval-report.json',
 *   fs: new DiskFileSystem(),
 * });
 * ```
 */
export interface JsonEvalReporterOptions {
  /**
   * File path written after `onFinish()` when set.
   */
  path?: string;
  /**
   * File system implementation with a `writeFile()` method.
   *
   * Defaults to no file output. Tests can pass `DiskFileSystem`; applications
   * may pass another compatible file system.
   */
  fs?: {
    writeFile(path: string, data: string): Promise<void>;
  };
}
/**
 * Base class for evaluation report sinks.
 *
 * `evaluate()` calls `onStart()` just before the first case executes,
 * `onCase()` after each case is scored, and `onFinish()` from the trailing
 * summary test. Every hook is awaited, so a slow reporter delays the tests it
 * observes. The base implementations are no-ops; subclasses override only the
 * hooks they care about.
 *
 * ```ts no_run
 * import { EvalReporter, type EvalCaseReport } from 'fino:ai/eval';
 *
 * class ConsoleReporter extends EvalReporter {
 *   override async onCase(r: EvalCaseReport): Promise<void> {
 *     console.log(`${r.name}: ${r.score.toFixed(3)} ${r.pass ? 'PASS' : 'FAIL'}`);
 *   }
 * }
 * ```
 */
export abstract class EvalReporter {
  /**
   * Called once, just before the first case runs, with the suite name and
   * total case count.
   */
  async onStart(_suite: { name: string; cases: number }): Promise<void> {}
  /**
   * Called after each case has been executed and scored.
   */
  async onCase(_r: EvalCaseReport): Promise<void> {}
  /**
   * Called once from the summary test with the aggregate result.
   */
  async onFinish(_summary: EvalSummary): Promise<void> {}
}
/**
 * Reporter that publishes live evaluation progress as a retained signal.
 *
 * Each hook updates the `progress` signal: `onStart()` resets it with the
 * suite name and total, `onCase()` advances the completed/passed counts and
 * running mean, and `onFinish()` snaps the snapshot to the final summary.
 * Useful for driving UIs or log output that watches a long evaluation run.
 *
 * ```ts no_run
 * import { evaluate, exactMatch, EvalProgressReporter } from 'fino:ai/eval';
 *
 * const reporter = new EvalProgressReporter();
 * reporter.progress.subscribe((p) => {
 *   console.log(`${p.completed}/${p.total} (${p.passed} passed)`);
 * });
 *
 * evaluate({
 *   name: 'formatter',
 *   cases: [{ name: 'upper', input: 'a', expected: 'A' }],
 *   target: async (input: string) => input.toUpperCase(),
 *   scorers: [exactMatch()],
 *   report: reporter,
 * });
 * ```
 */
export class EvalProgressReporter extends EvalReporter {
  #progress = createSignal<EvalProgress>({
    name: '',
    passed: 0,
    total: 0,
    completed: 0,
    mean: 0,
  });
  #scores: number[] = [];

  /**
   * Retained signal holding the latest progress snapshot.
   *
   * Read `.get()` for the current value; `subscribe()` observes subsequent
   * updates only.
   */
  get progress(): ReadonlySignal<EvalProgress> {
    return this.#progress;
  }

  /**
   * Resets progress to zero with the suite's name and case count.
   */
  async onStart(suite: { name: string; cases: number }): Promise<void> {
    this.#scores = [];
    this.#progress.set({
      name: suite.name,
      passed: 0,
      total: suite.cases,
      completed: 0,
      mean: 0,
    });
  }

  /**
   * Advances completed/passed counts and the running mean score.
   */
  async onCase(r: EvalCaseReport): Promise<void> {
    this.#scores.push(r.score);
    const current = this.#progress.get();
    this.#progress.set({
      ...current,
      passed: current.passed + (r.pass ? 1 : 0),
      completed: this.#scores.length,
      mean: this.#scores.reduce((a, b) => a + b, 0) / this.#scores.length,
    });
  }

  /**
   * Sets the snapshot to the final summary, marking every case completed.
   */
  async onFinish(summary: EvalSummary): Promise<void> {
    this.#progress.set({
      name: summary.name,
      passed: summary.passed,
      total: summary.total,
      completed: summary.total,
      mean: summary.mean,
    });
  }
}
/**
 * Eval reporter that stores deterministic JSON-friendly reports.
 *
 * Use this reporter when local CI should write or compare an eval artifact
 * without sending telemetry to an external service. `toJSON()` returns cloned
 * data sorted by case name for stable output, and when both `path` and `fs`
 * are configured the report is also written to disk after `onFinish()`.
 *
 * ```ts no_run
 * import { evaluate, exactMatch, JsonEvalReporter } from 'fino:ai/eval';
 * import { DiskFileSystem } from 'fino:file';
 *
 * const reporter = new JsonEvalReporter({
 *   path: './eval-report.json',
 *   fs: new DiskFileSystem(),
 * });
 *
 * evaluate({
 *   name: 'formatter',
 *   cases: [{ name: 'upper', input: 'a', expected: 'A' }],
 *   target: async (input: string) => input.toUpperCase(),
 *   scorers: [exactMatch()],
 *   report: reporter,
 * });
 * ```
 */
export class JsonEvalReporter extends EvalReporter {
  #suite?: {
    name: string;
    cases: number;
  };
  #cases: EvalCaseReport[] = [];
  #summary?: EvalSummary;
  #opts: JsonEvalReporterOptions;
  /**
   * Creates a reporter; pass `path` and `fs` to also write the report to disk
   * when the run finishes.
   */
  constructor(opts: JsonEvalReporterOptions = {}) {
    super();
    this.#opts = opts;
  }
  /**
   * Records the suite name and case count for the report header.
   */
  async onStart(suite: { name: string; cases: number }): Promise<void> {
    this.#suite = { ...suite };
  }
  /**
   * Stores a deep clone of the case report, so later mutation of the
   * original cannot affect the artifact.
   */
  async onCase(r: EvalCaseReport): Promise<void> {
    this.#cases.push(structuredClone(r));
  }
  /**
   * Records the summary and, when `path` and `fs` were configured, writes the
   * pretty-printed JSON report to disk.
   */
  async onFinish(summary: EvalSummary): Promise<void> {
    this.#summary = { ...summary };
    if (this.#opts.path && this.#opts.fs) {
      await this.#opts.fs.writeFile(
        this.#opts.path,
        new TextEncoder().encode(JSON.stringify(this.toJSON(), null, 2) + '\n'),
      );
    }
  }
  /**
   * Returns the accumulated report as freshly cloned data.
   *
   * Cases are sorted by name for deterministic output; `suite` and `summary`
   * are included once the corresponding lifecycle hooks have fired. Mutating
   * the returned object does not affect the reporter's stored state.
   */
  toJSON(): JsonEvalReport {
    return {
      ...(this.#suite ? { suite: { ...this.#suite } } : {}),
      cases: [...this.#cases]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((item) => structuredClone(item)),
      ...(this.#summary ? { summary: { ...this.#summary } } : {}),
    };
  }
}
/**
 * Options for `evaluate()`.
 *
 * ```ts no_run
 * import { evaluate, exactMatch, contains, type EvalOptions } from 'fino:ai/eval';
 *
 * const opts: EvalOptions<string, string> = {
 *   name: 'city extraction',
 *   target: async (input) => extractCity(input),
 *   cases: [{ name: 'simple', input: 'I live in Paris', expected: 'Paris' }],
 *   scorers: { exact: exactMatch(), mentionsCity: contains('Paris') },
 *   threshold: 1,
 * };
 * evaluate(opts);
 * ```
 */
export interface EvalOptions<In = unknown, Out = unknown> {
  /**
   * Name of the test suite registered with the runner.
   */
  name: string;
  /**
   * Function under evaluation; called once per case with the case's input.
   */
  target: (input: In) => Promise<Out>;
  /**
   * Finite cases to run, each becoming one test in the suite.
   *
   * Arrays are snapshotted into a `Dataset`; an existing `Dataset` can be
   * shared directly with memory, inference, or training workflows. A lazy
   * `IterableDataset` cannot be used here because the test runner registers
   * named cases synchronously.
   */
  cases: readonly EvalCase<In, Out>[] | Dataset<EvalCase<In, Out>>;
  /**
   * Scorers applied to every output. A record names each scorer by its key;
   * an array falls back to each function's `scorerName` or `name`.
   */
  scorers: Scorer<Out>[] | Record<string, Scorer<Out>>;
  /**
   * Minimum mean score for a case (and for the suite mean) to pass. Also the
   * cutoff applied when a scorer returns a bare number. Defaults to `1`.
   */
  threshold?: number;
  /**
   * Optional reporter that receives start, per-case, and finish events.
   */
  report?: EvalReporter;
}
function scorerEntries<Out>(
  scorers: Scorer<Out>[] | Record<string, Scorer<Out>>,
): Array<[string | undefined, Scorer<Out>]> {
  if (Array.isArray(scorers)) return scorers.map((scorer) => [undefined, scorer]);
  return Object.entries(scorers);
}
function normalizeScoreResult(raw: number | ScoreResult, threshold: number): ScoreResult {
  if (typeof raw === 'number') {
    return {
      value: raw,
      pass: raw >= threshold,
    };
  }
  return {
    value: raw.value,
    pass: raw.pass,
    explanation: raw.explanation,
  };
}
/**
 * Register an evaluation suite with the Fino test runner.
 *
 * Call it at module load in a test file; `fino test` then runs one test per
 * case plus a trailing `summary` test. Each case test awaits `target(input)`,
 * runs every scorer against the output, records the mean scorer value as the
 * case score (a case with no scorers scores `1`), attaches the score as test
 * metadata, and asserts the mean reaches `threshold`. The summary test asserts
 * that the mean over all case scores also reaches the threshold.
 *
 * When a reporter is supplied, `onStart()` fires just before the first case
 * executes, `onCase()` after each case, and `onFinish()` from the summary
 * test. A target or scorer that throws fails that case's test rather than
 * being converted into a score.
 *
 * ```ts no_run
 * import { evaluate, exactMatch, contains } from 'fino:ai/eval';
 *
 * evaluate({
 *   name: 'city extraction',
 *   target: async (input: string) => extractCity(input),
 *   cases: [
 *     { name: 'simple', input: 'I live in Paris', expected: 'Paris' },
 *     { name: 'trailing punctuation', input: 'Moving to Tokyo!', expected: 'Tokyo' },
 *   ],
 *   scorers: { exact: exactMatch(), nonEmpty: contains('') },
 *   threshold: 1,
 * });
 * ```
 */
export function evaluate<In = unknown, Out = unknown>(opts: EvalOptions<In, Out>): void {
  const { name, target, cases, scorers, threshold = 1, report } = opts;
  const caseDataset = cases instanceof Dataset ? cases : Dataset.from(cases);
  const registeredCases = caseDataset.toArray();
  const runningScore = new StreamingMean();
  let passedCount = 0;
  let startCalled = false;
  suite(name, () => {
    for (const c of registeredCases) {
      test(c.name, async (t) => {
        if (!startCalled) {
          startCalled = true;
          await report?.onStart({
            name,
            cases: caseDataset.length,
          });
        }
        const output = await target(c.input);
        const scorerResults: Record<string, ScoreResult> = {};
        const scoreValues: number[] = [];
        for (const [name, scorer] of scorerEntries(scorers)) {
          const scorerName =
            name ??
            (
              scorer as {
                scorerName?: string;
              }
            ).scorerName ??
            scorer.name ??
            'scorer';
          const raw = await scorer(output, c as EvalCase<unknown, Out>);
          const sr = normalizeScoreResult(raw, threshold);
          scorerResults[scorerName] = sr;
          scoreValues.push(sr.value);
        }
        const meanScore =
          scoreValues.length > 0 ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length : 1;
        const passes = meanScore >= threshold;
        runningScore.update(meanScore);
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
      const mean = runningScore.count > 0 ? runningScore.value() : 1;
      const passes = mean >= threshold;
      t.meta({
        mean: mean.toFixed(3),
        passed: passedCount,
        total: caseDataset.length,
      });
      t.ok(passes, `mean score ${mean.toFixed(3)} >= threshold ${threshold}`);
      await report?.onFinish({
        name,
        mean,
        passed: passedCount,
        total: caseDataset.length,
      });
    });
  });
}
/**
 * Scorer for exact equality between the output and the case's expected value.
 *
 * Compares `JSON.stringify(output)` against `JSON.stringify(expected)`, so
 * deep object equality works but property order matters. Scores `1`/pass on a
 * match and `0`/fail otherwise. Reports under the name `exactMatch`.
 *
 * ```ts no_run
 * import { evaluate, exactMatch } from 'fino:ai/eval';
 *
 * evaluate({
 *   name: 'classifier',
 *   cases: [{ name: 'positive review', input: 'Loved it!', expected: { label: 'positive' } }],
 *   target: async (input) => classify(input),
 *   scorers: [exactMatch()],
 * });
 * ```
 */
export function exactMatch(): Scorer {
  const fn = (output: unknown, c: EvalCase): ScoreResult => {
    const pass = JSON.stringify(output) === JSON.stringify(c.expected);
    return {
      value: pass ? 1 : 0,
      pass,
    };
  };
  (
    fn as {
      scorerName?: string;
    }
  ).scorerName = 'exactMatch';
  return fn;
}
/**
 * Scorer that checks whether the output text contains `substr`.
 *
 * Non-string outputs are JSON-stringified before the check. Scores `1`/pass
 * when the substring is present and `0`/fail otherwise; the case's `expected`
 * value is not consulted. Reports under the name `contains(<substr>)`.
 *
 * ```ts no_run
 * import { evaluate, contains } from 'fino:ai/eval';
 *
 * evaluate({
 *   name: 'support answer',
 *   cases: [{ name: 'refund policy', input: 'refund window?' }],
 *   target: async (input) => askSupportBot(input),
 *   scorers: [contains('30 days')],
 * });
 * ```
 */
export function contains(substr: string): Scorer {
  const fn = (output: unknown): ScoreResult => {
    const str = typeof output === 'string' ? output : JSON.stringify(output);
    const pass = str.includes(substr);
    return {
      value: pass ? 1 : 0,
      pass,
    };
  };
  (
    fn as {
      scorerName?: string;
    }
  ).scorerName = `contains(${substr})`;
  return fn;
}
/**
 * Scorer that validates the output against a JSON schema.
 *
 * The schema is compiled once with `fino:validate` when the scorer is
 * created. Valid outputs score `1`/pass; invalid outputs score `0`/fail with
 * an explanation listing each validation issue as `path: message`. Reports
 * under the name `schemaScorer`.
 *
 * ```ts no_run
 * import { evaluate, schemaScorer } from 'fino:ai/eval';
 *
 * evaluate({
 *   name: 'structured extraction',
 *   cases: [{ name: 'contact card', input: 'Ada Lovelace <ada@example.com>' }],
 *   target: async (input) => extractContact(input),
 *   scorers: [schemaScorer({
 *     type: 'object',
 *     properties: { name: { type: 'string' }, email: { type: 'string' } },
 *     required: ['name', 'email'],
 *   })],
 * });
 * ```
 */
export function schemaScorer(schema: unknown): Scorer {
  const compiled = compile(schema as Record<string, unknown>);
  const fn = (output: unknown): ScoreResult => {
    const r = compiled.safeParse(output);
    const pass = r.success;
    const explanation = pass
      ? undefined
      : r.issues
          ?.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`)
          .join('; ');
    return {
      value: pass ? 1 : 0,
      pass,
      explanation,
    };
  };
  (
    fn as {
      scorerName?: string;
    }
  ).scorerName = 'schemaScorer';
  return fn;
}
/**
 * Scorer that asks a model to grade the output against a rubric.
 *
 * Builds a single-model agent and prompts it with the rubric, the case input,
 * the expected value (or `none` when absent), and the output, requesting a
 * JSON object of the form `{"score": 0.0, "explanation": "..."}`. The score
 * is clamped to `[0, 1]`; a response that is not valid JSON scores `0`. The
 * scorer's own `pass` flag is set only for a perfect `1`, but `evaluate()`
 * judges the case by mean score against its threshold, so partial credit
 * still counts. Reports under the name `llmJudge`.
 *
 * Judged scores inherit the judge model's variance — pin or stub the model in
 * CI and treat the rubric as policy rather than ground truth.
 *
 * ```ts no_run
 * import { evaluate, llmJudge } from 'fino:ai/eval';
 * import { anthropic } from 'fino:ai/model';
 *
 * evaluate({
 *   name: 'tone check',
 *   cases: [{ name: 'greeting', input: 'Say hi to Ada', expected: 'A warm greeting addressed to Ada' }],
 *   target: async (input) => runAssistant(input),
 *   scorers: [llmJudge(anthropic(), 'The answer must be polite and match the expected description.')],
 *   threshold: 0.8,
 * });
 * ```
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
    let obj:
      | {
          score?: number;
          explanation?: string;
        }
      | undefined;
    try {
      obj = JSON.parse(result.text) as typeof obj;
    } catch {
      obj = undefined;
    }
    const value = Math.max(0, Math.min(1, obj?.score ?? 0));
    return {
      value,
      pass: value >= 1,
      explanation: obj?.explanation,
    };
  };
  (
    fn as {
      scorerName?: string;
    }
  ).scorerName = 'llmJudge';
  return fn;
}
/**
 * Scorer that compares the output and expected value by embedding similarity.
 *
 * Embeds both texts with the given embedding model (non-strings are
 * JSON-stringified first) and scores their cosine similarity, passing when
 * the similarity reaches `min`. A case without an `expected` value scores
 * `0`/fail with a `'no expected value'` explanation. Reports under the name
 * `semanticSimilarity(<min>)`.
 *
 * Because the raw cosine value is the score, pair this scorer with a
 * `threshold` below `1` — identical wording is rarely required, only meaning.
 *
 * ```ts no_run
 * import { evaluate, semanticSimilarity } from 'fino:ai/eval';
 * import { openai } from 'fino:ai/model';
 *
 * evaluate({
 *   name: 'paraphrase quality',
 *   cases: [{ name: 'refund', input: 'refund window?', expected: 'Refunds are accepted within 30 days.' }],
 *   target: async (input) => paraphraseBot(input),
 *   scorers: [semanticSimilarity(openai(), 0.85)],
 *   threshold: 0.85,
 * });
 * ```
 */
export function semanticSimilarity(model: EmbeddingModel, min: number): Scorer {
  const fn = async (output: unknown, c: EvalCase): Promise<ScoreResult> => {
    const outStr = typeof output === 'string' ? output : JSON.stringify(output);
    const expStr =
      c.expected !== undefined
        ? typeof c.expected === 'string'
          ? c.expected
          : JSON.stringify(c.expected)
        : '';
    if (!expStr)
      return {
        value: 0,
        pass: false,
        explanation: 'no expected value',
      };
    const [outEmb, expEmb] = await model.embed([outStr, expStr]);
    if (!outEmb || !expEmb || outEmb.length !== expEmb.length)
      return {
        value: 0,
        pass: false,
      };
    const cosine = cosineSimilarity(outEmb, expEmb);
    const pass = cosine >= min;
    return {
      value: cosine,
      pass,
      explanation: `cosine similarity ${cosine.toFixed(4)}`,
    };
  };
  (
    fn as {
      scorerName?: string;
    }
  ).scorerName = `semanticSimilarity(${min})`;
  return fn;
}
/**
 * Options for `OpenTelemetryReporter`.
 *
 * Provide `exporter` (a pre-built exporter instance) or `endpoint` (an
 * OTLP/HTTP JSON collector URL) to have the reporter start and own a
 * dedicated OpenTelemetry SDK for the run. With neither, the reporter emits
 * through whatever logger and meter providers are already registered.
 *
 * ```ts no_run
 * import { OpenTelemetryReporter } from 'fino:ai/eval';
 *
 * const reporter = new OpenTelemetryReporter({
 *   endpoint: 'http://localhost:4318',
 *   headers: { authorization: `Bearer ${token}` },
 * });
 * ```
 */
export interface OpenTelemetryReporterOptions {
  /**
   * OTLP/HTTP JSON endpoint used to build an exporter when `exporter` is not
   * supplied.
   */
  endpoint?: string;
  /**
   * Extra HTTP headers sent with OTLP requests to `endpoint`.
   */
  headers?: Record<string, string>;
  /**
   * Pre-built exporter used for spans, logs, and metrics; takes precedence
   * over `endpoint`.
   */
  exporter?: unknown;
  /**
   * Resource attached to the SDK the reporter starts. Ignored when no
   * dedicated SDK is started.
   */
  resource?: Resource;
}
/**
 * Eval reporter that emits OpenTelemetry GenAI evaluation telemetry.
 *
 * For each scorer result of each case it records a
 * `gen_ai.client.evaluation.score` histogram point and emits a
 * `gen_ai.evaluation.result` log event carrying the score value, a
 * `pass`/`fail` label, and the explanation when present. Case-level
 * `conversationId`/`responseId` become `gen_ai.conversation.id` and
 * `gen_ai.response.id` attributes.
 *
 * When constructed with an `exporter` or `endpoint`, `onStart()` boots a
 * dedicated `OtelSDK` and `onFinish()` flushes and shuts it down, so each run
 * is self-contained. Without either option the reporter emits through the
 * ambient logger/meter providers and never owns an SDK. Test outcomes are
 * unchanged either way — the telemetry is purely additive.
 *
 * ```ts no_run
 * import { evaluate, exactMatch, OpenTelemetryReporter } from 'fino:ai/eval';
 *
 * evaluate({
 *   name: 'formatter',
 *   cases: [{ name: 'upper', input: 'a', expected: 'A' }],
 *   target: async (input: string) => input.toUpperCase(),
 *   scorers: [exactMatch()],
 *   report: new OpenTelemetryReporter({ endpoint: 'http://localhost:4318' }),
 * });
 * ```
 */
export class OpenTelemetryReporter extends EvalReporter {
  #opts: OpenTelemetryReporterOptions;
  #sdk: OtelSDK | undefined;
  /**
   * Creates a reporter; pass `exporter` or `endpoint` to own a dedicated SDK
   * for the run, or neither to emit through ambient providers.
   */
  constructor(opts: OpenTelemetryReporterOptions = {}) {
    super();
    this.#opts = opts;
  }
  /**
   * Starts a dedicated OpenTelemetry SDK when an exporter or endpoint was
   * configured; otherwise does nothing.
   */
  async onStart(suite: { name: string; cases: number }): Promise<void> {
    const exp =
      this.#opts.exporter ??
      (this.#opts.endpoint
        ? new OTLPHttpJsonExporter({
            endpoint: this.#opts.endpoint,
            headers: this.#opts.headers,
          })
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
  /**
   * Records one histogram point and one log event per scorer result on the
   * `fino.ai.eval` meter and logger.
   */
  async onCase(r: EvalCaseReport): Promise<void> {
    const logger = getLoggerProvider().getLogger('fino.ai.eval');
    const meter = getMeterProvider().getMeter('fino.ai.eval');
    const evalScoreHist = meter.createHistogram('gen_ai.client.evaluation.score', {
      unit: '1',
      description: 'GenAI evaluation score',
    });
    for (const [scorerName, sr] of Object.entries(r.scores)) {
      const attrs: Record<string, unknown> = { 'gen_ai.evaluation.name': scorerName };
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
  /**
   * Flushes and shuts down the SDK started by `onStart()`, if any.
   */
  async onFinish(_summary: EvalSummary): Promise<void> {
    if (this.#sdk) {
      await this.#sdk.flush();
      await this.#sdk.shutdown();
      this.#sdk = undefined;
    }
  }
}
