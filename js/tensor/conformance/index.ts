/**
 * `fino:tensor/conformance` — check a backend against the reference oracle.
 *
 * ```ts no_run
 * import { runConformance, formatReport } from 'fino:tensor/conformance';
 * import { registerBackend } from 'fino:tensor';
 *
 * registerBackend(myProvider);
 * console.log(formatReport(await runConformance('mybackend')));
 * ```
 *
 * `fino:tensor/graph` and `fino:tensor/backend` are experimental, and the contract
 * says they stay that way until an out-of-tree backend passes this suite. That is what
 * this module is for: it is the thing an out-of-tree backend can run without living in
 * this repository, and the thing whose passing would let those surfaces settle.
 *
 * Every case is written against the public `fino:tensor` surface rather than against
 * backend methods. A backend conforms by making ordinary programs produce the right
 * numbers — not by implementing an interface in a particular way — so the suite does
 * not constrain how a backend is built, only what it computes.
 *
 * The reference CPU backend is the definition of correct. Running the suite on the
 * reference device therefore proves only that the cases execute, which the report says
 * plainly rather than counting as agreement.
 *
 * ## What it does not do
 *
 * It does not check performance, and it does not check every registered operation —
 * `uncovered` in the report lists what no case exercised, so an incomplete run says so
 * rather than implying more than it checked.
 *
 * Gradients are compared against the reference backend's, which is a different claim
 * from being right in the absolute. `gradCheck` in `internal:tensor/harness` is what
 * validates the tape itself against finite differences, in `f64`, on the CPU.
 *
 * ## Status
 *
 * Experimental, alongside the rest of `fino:tensor`.
 */
export {
  conformanceCases,
  formatReport,
  runConformance,
  runConformanceEverywhere,
} from './suite.ts';
export type {
  CaseResult,
  ConformanceCase,
  ConformanceOptions,
  ConformanceReport,
  Program,
} from './suite.ts';
