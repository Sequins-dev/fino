# Fino Classical ML and Numerics

> Status: research and direction-setting document.
>
> Parent: [typescript-model-factory.md](./typescript-model-factory.md) — the
> model-factory strategy. Siblings: [tensor-engine.md](./tensor-engine.md),
> [data-stack.md](./data-stack.md), [model-artifacts.md](./model-artifacts.md),
> [ml-workbench.md](./ml-workbench.md),
> [inference-serving.md](./inference-serving.md).
>
> Scope: tabular/classical machine learning and the dense numerics beneath
> it — linear-algebra decompositions, estimators, gradient-boosted trees,
> preprocessing, model selection, and the shared metrics module. Opinionated
> by design: a cohesive subset covering most applied-ML needs, every piece
> speaking Arrow/DataFrame/Tensor, not a full sklearn clone.

## 1. Thesis

Most applied ML is tabular, and its Python workhorses are scikit-learn and
gradient-boosted trees, not transformers. A model factory that cannot fit a
boosted-tree model on a Parquet file is missing the majority use case.

Fino's angle is the data language. Python's tabular path is a copy chain —
pandas → numpy → DMatrix, each boundary a conversion. Here estimators consume
Arrow record batches natively, preprocessing *is* the DataFrame expression
engine, splits and CV determinism ride `fino:data`, and results land back as
columns. The deliverable is not algorithm breadth; it is that the chosen
algorithms compose with everything else in the runtime without a single
representation change.

## 2. Standards To Anchor On

- **The sklearn estimator convention** — `fit`/`predict`/`transform` plus
  composable pipelines — is the de facto API standard of the field. Adopt
  the shape (not the letter): every estimator is seedable, disposable,
  `stateDict()`-serializable, and displayable via the MIME protocol.
- **XGBoost and LightGBM** are the GBDT standards. Both expose stable,
  plain-C ABIs (`libxgboost`, `lib_lightgbm`) — dlopen-able in the
  established candidate-path idiom, nothing vendored.
- **LAPACK** is the dense-decomposition standard, and it ships *inside* the
  OpenBLAS/Accelerate binaries the tensor engine already dlopens for GEMM —
  the numerics tier costs no new deployment surface.
- **ONNX-ML** (the `ai.onnx.ml` operator domain: TreeEnsemble,
  LinearClassifier, …) is the interchange format for classical models —
  inspect/read first, export later, consistent with the family-wide ONNX
  posture. PMML is rejected (legacy XML, weak ecosystem).
- **Arrow** is already the tabular currency (parent §7); this document adds
  no new interchange format.

## 3. Numerics — `fino:tensor/linalg`

- **Decompositions**: SVD, QR, eig/eigh, Cholesky, `solve`/`lstsq`,
  det/inverse, bound to LAPACK's Fortran ABI (`dgesvd_`, `dpotrf_`, …) from
  the same OpenBLAS/Accelerate dlopen the engine's CPU tier uses. CPU-first
  and correctness-first; GPU decompositions (cuSOLVER) are demand-gated
  later, behind the same functions.
- **Distributions**: extend the engine's seeded `Generator` beyond
  uniform/normal (gamma, beta, Poisson, binomial, categorical) with the same
  key-splitting scheme, so trajectories stay oracle-comparable across
  backends.
- **FFT** (`fino:tensor/fft`, via dlopen FFTW3) and **sparse matrices** are
  deferred until a consumer exists — spectral features and scipy-style
  sparse workflows are not on the near-term path.

## 4. Estimators — `fino:ml`

- **Engine-backed**: linear/logistic regression with ridge/lasso
  regularization (the BLAS CPU tier is sufficient — no GPU requirement for
  tabular work), PCA (falls out of `linalg` SVD), k-means. These validate
  the estimator convention on pure fino substrate.
- **GBDT — `fino:ml/boosted`**: one estimator surface over dlopen'd XGBoost
  (preferred) and LightGBM (both bound as `internal:*` modules; an option
  selects). Training matrices are constructed from Arrow columns — zero-copy
  where the C APIs allow, a bounded copy where they do not (verified in the
  spike, not assumed). Trained boosters save/load through their own native
  formats, wrapped in the content-addressed artifact store.
- **Preprocessing as DataFrame transforms**: scalers, one-hot/ordinal
  encoders, imputation, train/test split, and K-fold CV are expression-plan
  operations over record batches (`fino:data/frame`) — vectorized column
  kernels, not row-object churn. A `Pipeline` composes transforms and an
  estimator into one fit/predict object with a single `stateDict()`.

## 5. Metrics — `fino:ml/metrics`

One shared module, pure TS over tensors and columns: classification
(accuracy, precision/recall/F1, ROC-AUC, confusion matrix), regression
(MSE/MAE/R²), ranking (NDCG, MRR), and text (BLEU, ROUGE, perplexity
helpers). Consumed by training loops, estimator `.score()`,
[ml-workbench.md](./ml-workbench.md) tracking, and `fino:ai/eval` — one
implementation, every consumer, per the family's shared-primitives rule.
Metrics have no dependencies beyond the tensor/column types and land first.

## 6. The Data Language, End to End

The proof-of-cohesion flow: Parquet → DataFrame transforms (impute, encode,
split) → `boosted.fit(train)` → `metrics.rocAuc(model.predict(test), y)` →
tracked run in the workbench store → model persisted through
`fino:model/artifacts` → served behind the same app that consumed the
predictions. Every arrow in that chain is a record batch or a tensor; no
stage introduces a private representation.

## 7. Sequencing

- **Metrics first** — pure TS, no dependencies, immediately unblocks
  `fino:ai/eval` and training loops.
- **GBDT + preprocessing** after `fino:data/frame` lands
  ([data-stack.md](./data-stack.md)); no tensor-engine dependency.
- **Linear/PCA/k-means + `linalg`** ride the engine's Phase 1 CPU substrate
  (the BLAS binding is the same dlopen; LAPACK symbols come along).
- **FFT, ONNX-ML export, cuSOLVER**: demand-gated.

## 8. Risks and Open Questions

- **GBDT deployment surface.** Linux distros do not reliably package
  XGBoost/LightGBM; the shared libraries usually arrive via brew, conda, or
  inside pip wheels. Candidate-path probing must cover those layouts, and
  the spike must confirm it is acceptable in practice.
- **LAPACK ABI variance.** LP64 vs. ILP64 symbol conventions (Accelerate's
  newer ILP64 interface, OpenBLAS build flags) differ by platform; probe and
  normalize at bind time.
- **Arrow-to-training-matrix zero-copy is claimed, not verified** for either
  booster's C API.
- **Scope creep is the real risk.** The sklearn surface is enormous; the
  opinionated line (linear models, boosted trees, k-means, PCA,
  preprocessing, CV, metrics) covers most needs, and ONNX-ML *import* is the
  escape hatch for running the long tail trained elsewhere.

## Sources

- scikit-learn API conventions: https://scikit-learn.org/stable/developers/develop.html
- XGBoost C API tutorial: https://xgboost.readthedocs.io/en/stable/tutorials/c_api_tutorial.html
- LightGBM C API: https://lightgbm.readthedocs.io/en/latest/C-API.html
- LAPACK: https://www.netlib.org/lapack/
- FFTW: https://www.fftw.org/
- ONNX-ML operator domain: https://onnx.ai/onnx/operators/
