# Fino ML Workbench

> Status: research and direction-setting document.
>
> Parent: [typescript-model-factory.md](./typescript-model-factory.md) — the
> model-factory strategy. Siblings: [tensor-engine.md](./tensor-engine.md),
> [data-stack.md](./data-stack.md), [model-artifacts.md](./model-artifacts.md),
> [inference-serving.md](./inference-serving.md),
> [classical-ml.md](./classical-ml.md).
>
> Scope: the interactive and operational surface of the model factory —
> notebooks and the display protocol, visualization, experiment tracking, and
> durable training runs. General data-science infrastructure: all of it is
> useful for data work with no tensor engine present, and none of it blocks
> on the engine.

## 1. Notebooks

The moat is real; the answer is layered. First, a **display protocol**:
Jupyter's MIME-bundle convention, adopted verbatim — anything showable
(DataFrame, Tensor, chart, tracked run) implements
`[Symbol.for('fino.display')]() → { 'text/html': ..., 'text/plain': ... }`.
Then a **native notebook** (`fino notebook`): HTTP server + `fino:ui` JSX
frontend; cells execute in a persistent thread realm driven by the existing
V8 inspector infrastructure (restart = kill realm; capability narrowing per
notebook — something Jupyter cannot do). The file format is **plain
TypeScript with `// %%` cell markers** — git-diffable, runnable as a
script, type-checked — with `.ipynb` import/export. A real Jupyter kernel
(five ZeroMQ sockets + JSON + HMAC; libzmq is a clean C dlopen) is v2.

## 2. Visualization — `fino:viz`, kept light

Vega-Lite spec emission as the core
(`plot(df).mark('line').x('epoch').y('loss')` → VL JSON), rendered by the
notebook frontend, exportable as standalone HTML, with a `fino:tty/tui`
sparkline fallback for loss curves in a terminal. No rendering engine is
built.

## 3. Experiment Tracking — `fino:train` + `fino:train/track`

A sqlite-backed local store (runs, params, metric series, artifacts sharing
the content-addressed blob store, git commit + data snapshot metadata),
dual-emitting metrics to `fino:opentelemetry`; `fino track ui` serves a
local dashboard. Training loops integrate with `fino:workflow`:
epochs/eval/checkpoint as checkpointed steps plus DataLoader state (the
loader's `state()`/`restore()` is specced in
[data-stack.md](./data-stack.md)), so a killed job resumes exactly.
Durable-by-default training is a genuine differentiator; PyTorch resume is
artisanal. Metric *computation* is not implemented here: it lives in
`fino:ml/metrics` ([classical-ml.md](./classical-ml.md)) — one shared
implementation for training loops, estimators, and `fino:ai/eval`; tracking
stores and displays what it produces.

## 4. Hyperparameter Search

Fino gets an Optuna-class tool by composition rather than a new system. A
sweep is a study over `fino:workflow`-backed trials: each trial is a durable
run — kill/resume works mid-sweep — executed in parallel over
`fino:realm/pool`, recording into the same tracking store, so the dashboard
shows sweeps with no extra plumbing. Samplers start with random search plus
TPE; ASHA/successive-halving early stopping reads the loss curves already in
the metric store. Search spaces are plain seeded-deterministic objects, and a
study exposes `state()`/`restore()` like everything else stateful.

## 5. Sequencing

This doc's slice of the parent roadmap:

- The display protocol is cheap and early — it is a convention, not a
  system, and everything showable adopts it as it lands.
- **Phase 3 slice:** DataLoader/train/track/notebook UX hardening;
  checkpoint/resume through `fino:workflow`; hyperparameter sweeps (§4)
  follow once tracking and workflow integration are solid.
- **Phase 4:** the Jupyter kernel (ZeroMQ transport).

## Sources

- Jupyter messaging protocol: https://jupyter-client.readthedocs.io/en/latest/messaging.html
- Vega-Lite: https://vega.github.io/vega-lite/
- Optuna (the sweep-tool benchmark): https://optuna.readthedocs.io/
- ASHA (asynchronous successive halving): https://arxiv.org/abs/1810.05934
