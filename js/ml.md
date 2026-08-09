---
weight: 145
---
# Machine Learning

Fino's machine-learning surface is pure TypeScript over ordinary arrays. It
carries no native dependencies and does not require a tensor engine, so it runs
anywhere the runtime does — including inside `DataLoader` worker realms.

## Metrics

`fino:ml/metrics` is the single implementation of the standard scoring
functions. Evaluation harnesses, estimators, and inference pipelines all import
it rather than growing private scorers, so the same data produces the same
number no matter which layer reports it.

```ts no_run
import { ConfusionMatrix, f1Score, rocAuc } from 'fino:ml/metrics';

const yTrue = [1, 0, 1, 1, 0, 1];
const yPred = [1, 0, 0, 1, 0, 1];

console.log(f1Score(yTrue, yPred));
console.log(rocAuc(yTrue, [0.9, 0.1, 0.4, 0.8, 0.2, 0.7]));
console.log(ConfusionMatrix.from(yTrue, yPred).format());
```

### Picking the right one

Which metric to use is a modeling decision, not a formatting one:

- **Hard predictions.** `accuracy` is the obvious summary and the most
  misleading one — on imbalanced data a model that only ever predicts the
  majority class scores well. `balancedAccuracy`, `f1Score`, and
  `matthewsCorrCoef` do not reward that. `precision` and `recall` separate the
  two ways a classifier fails; `fBetaScore` weights one against the other when
  a miss and a false alarm cost different amounts.
- **Scores without a threshold.** `rocAuc` summarizes ranking quality across
  every possible cutoff. `averagePrecision` answers the same question while
  ignoring true negatives, which is the honest choice when positives are rare
  and a large easy negative class would otherwise inflate the picture.
- **Probabilities that get used as probabilities.** A model can rank perfectly
  and still be badly calibrated. `logLoss`, `brierScore`,
  `expectedCalibrationError`, and `calibrationCurve` ask whether a predicted
  `0.9` actually happens 90% of the time — which is what matters as soon as
  something downstream thresholds on that number.
- **Ranked results.** `precisionAtK`, `recallAtK`, `ndcgAtK`, and
  `meanReciprocalRank` score a result list where position matters. Use
  `rankedRelevance` to turn ranked ids plus a relevant set into the shape they
  expect.
- **Continuous targets.** `meanSquaredError` punishes large misses hardest,
  `meanAbsoluteError` treats every unit of error alike, and
  `medianAbsoluteError` ignores outliers entirely. `r2Score` reports the share
  of variance explained, where `0` means "no better than predicting the mean".

`ConfusionMatrix` derives the whole classification family from one pass, so
prefer it whenever more than one score is needed:

```ts no_run
import { ConfusionMatrix } from 'fino:ml/metrics';

const cm = ConfusionMatrix.from(trueLabels, predictedLabels);
for (const row of cm.report()) {
  console.log(row.label, row.precision, row.recall, row.f1, row.support);
}
```

### Streaming and sharded evaluation

Batch functions need the whole dataset in memory at once. The `Streaming*`
accumulators do not: they hold constant memory, take one batch at a time, and
`merge` across shards, so a metric computed by parallel realm workers equals
the one computed serially. This is the surface to use with `DataLoader`.

```ts no_run
import { StreamingConfusionMatrix } from 'fino:ml/metrics';

const running = new StreamingConfusionMatrix(['spam', 'ham']);
for await (const batch of loader) {
  running.updateAll(batch.labels, await classify(batch.inputs));
}
console.log(running.value().macroF1());
```

Passing the label set to the constructor pins the universe: an unexpected class
becomes an error instead of a silent schema change, and classes absent from a
shard still appear in its report. Leave it off and the universe grows as new
labels arrive.

`merge` returns a new accumulator and leaves both operands untouched, so a
fan-out can reduce partial results in any order:

```ts no_run
import { StreamingRegression } from 'fino:ml/metrics';

const shards = await Promise.all(partitions.map((p) => scoreInRealm(p)));
const total = shards.reduce((a, b) => a.merge(b), new StreamingRegression());
console.log(total.value().rootMeanSquaredError);
```

### Conventions

Inputs are `ArrayLike<number>`, so plain arrays and typed arrays both work.
Labels are strings, numbers, or booleans, compared by value.

Binary metrics need to know which label is positive. `{0, 1}` resolves to `1`
and `{false, true}` to `true`; anything else must say so with `positiveLabel`.
Multiclass scores combine through `average`: `macro` treats classes equally,
`weighted` follows support, `micro` pools counts, and `none` returns one score
per class.

Malformed input — mismatched lengths, empty arrays, probabilities outside
`[0, 1]`, an unresolvable positive label — throws `MetricError`. Values that
are genuinely undefined, such as the precision of a class that was never
predicted, are reported as `0` rather than `NaN`, so an aggregate never turns
into `NaN` because one class was missing.

## Data and evaluation

`fino:ml/metrics` pairs with the [Data](./data.md) guide's `Dataset` and
`DataLoader` for feeding batches, and with
[Evals and OpenTelemetry](./ai/evals-opentelemetry.md), which uses these
metrics to score AI behavior inside the test runner.
