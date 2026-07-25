# Fino Data Stack

> Status: research and direction-setting document.
>
> Parent: [typescript-model-factory.md](./typescript-model-factory.md) — the
> model-factory strategy. Siblings: [tensor-engine.md](./tensor-engine.md),
> [model-artifacts.md](./model-artifacts.md),
> [ml-workbench.md](./ml-workbench.md),
> [inference-serving.md](./inference-serving.md),
> [classical-ml.md](./classical-ml.md).
>
> Scope: general-purpose data infrastructure — Arrow-centered tabular data,
> Parquet and its reusable format dependencies, a DataFrame layer, and the
> Dataset/DataLoader pipeline. This stack is engine-independent: it is useful
> for any data work in Fino, and only the `column.toTensor()` boundary
> touches [tensor-engine.md](./tensor-engine.md).

## 1. Principles

Data is Arrow-first and streaming-first. The format tier is **complete**:
`fino:data/arrow` provides the Arrow substrate and `fino:data/parquet`
provides Parquet, both on reusable generic modules (`internal:format/thrift`,
Snappy in `fino:compress`) that landed with them. The remaining pieces are the
*consumers* — a query/DataFrame layer and a Dataset/DataLoader — and those are
now the priority, because until they exist the columnar tier has no user
inside the runtime.

The guiding principle here is the same one that produced `fino:format/flatbuffers`
and the `fino:compress` codecs: **untangle the dependency tree into discrete,
generalized modules** rather than adopt a bundled engine that re-clusters the
functionality. The obvious shortcut — dlopen DuckDB as a Parquet + CSV/JSON +
SQL "workhorse" — is rejected for exactly that reason: it collapses a whole
cluster back into one opaque internal, which is what this runtime exists to
avoid. Parquet decomposes cleanly into reusable parts we mostly already have.

## 2. The Modules

- **`fino:data/arrow` — Arrow (exists).** The columnar in-memory format (all
  logical types), the IPC stream and file formats (with LZ4/ZSTD body
  compression), and the Arrow C Data Interface (`fino:data/arrow/cdata`) are
  implemented and tested. It is the tabular interchange the rest of the data
  stack consumes and produces: `column.toTensor()`, `RecordBatch`/`Table`, and
  zero-copy hand-off to native libraries via `Pointer.view`.
- **`internal:format/thrift` — generic Thrift codec (exists).** Parquet's file
  metadata (`FileMetaData`, `RowGroup`, `ColumnChunk`, `Statistics`, …) is
  serialized with Thrift's compact protocol. Like flatbuffers, Thrift is a
  general-purpose format that belongs in its own module, not buried in a
  Parquet reader — and it landed as one: a schema-less compact-protocol
  reader/writer (with binary and JSON protocols alongside) that any consumer
  can use. Currently `internal:*`; promoting it to `fino:format/thrift` is a
  one-line loader change whenever an external consumer wants it.
- **`fino:compress` + Snappy (exists).** Parquet's default page codec is
  Snappy; gzip/brotli/zstd/lz4 (which Parquet also permits) were already
  there. Snappy landed in the generic compress module
  (`internal:compress/snappy`), not in Parquet internals.
- **`fino:data/parquet` — native Parquet (exists).** Built on
  `internal:format/thrift` + `fino:compress` + `fino:data/arrow`: reads and
  writes the full column layout (PLAIN, RLE/bit-packed dictionary, the DELTA
  family, delta-length/byte-array, byte-stream-split, plus page compression,
  statistics, and nested repetition/definition levels), producing and
  consuming Arrow record batches, golden-tested against pyarrow-generated
  fixtures. The decomposition thesis held: the generic parts came out reusable
  and the format-specific part stayed bounded — the opposite of importing a
  multi-feature engine to get one format.
- **`fino:data/frame` — DataFrame over Arrow (planned).** A lazy DataFrame that
  builds an expression plan and executes it with its own small operator set
  (filter, project, groupBy/agg, join, sort, limit) *directly over Arrow
  record batches* — vectorized column kernels, not SQL compiled to a foreign
  engine. Predicate/projection pushdown targets the `fino:data/parquet` reader
  (skip row groups by statistics, read only needed columns). If a SQL surface
  is wanted later it parses to the same plan; the execution engine stays ours.
- **`fino:data` — Dataset/DataLoader (planned).** `Dataset` (random access) and
  `IterableDataset` (async iterable) with `map/filter/shuffle(buffer)/batch/
  take/split/interleave`; sources from CSV/JSONL (existing modules), Arrow
  IPC, `fino:data/parquet`, sqlite, HTTP, and the hub. `DataLoader` runs the
  decode/augment/tokenize pipeline on `fino:realm/pool` workers writing
  collated batches into SharedArrayBuffer slabs (a ring allocator); the
  training realm receives `{sab, offset, shape, dtype}` descriptors —
  zero-copy across realms today. Determinism is first-class: one seed derives
  per-worker/per-epoch streams; loaders expose `state()`/`restore()` so
  `fino:workflow` can checkpoint mid-epoch position.

The flow `Parquet → DataFrame → Arrow batch → column.toTensor() → GPU` is
pointer-passing at every boundary via `Pointer.view`, and every stage is a
fino module that stands alone rather than a facet of one bundled dependency.

## 3. Sequencing

The data stack's slice of the parent roadmap:

- **Phase 0 — done.** `internal:format/thrift`, Snappy in `fino:compress`,
  and `fino:data/parquet` have all landed, with golden tests.
- **Next, and now the highest-leverage work in this document:**
  `fino:data/frame` and `fino:data` (Dataset/DataLoader). These are what give
  the format tier a consumer, and what the training loop, `fino:ai/eval`, and
  batch inference ([inference-serving.md](./inference-serving.md) §5) all
  build on. `fino:data` today is a re-export of the Arrow namespace and
  nothing more.
- **Phase 3 slice:** DataLoader hardening — worker-pool pipeline, prefetch
  into the engine's pinned H2D ring, and `state()`/`restore()` integration
  with `fino:workflow` checkpointing (surfaced in
  [ml-workbench.md](./ml-workbench.md)).
- Vision datasets eventually need `fino:media/image` (decode via system
  jpeg-turbo/libpng) plus augmentation transforms — random crop/flip/color
  jitter as DataLoader-stage tensor ops running on the worker pool; that
  lives in the parent roadmap's later items.

## 4. Risks and Open Questions

- **The DataFrame's scope is the live risk** now that Parquet is done. A lazy
  expression plan with its own vectorized operator set is open-ended work, and
  "add SQL" is a standing temptation that would multiply it. Hold the line at
  the small operator set (filter, project, groupBy/agg, join, sort, limit) with
  pushdown into the Parquet reader's existing statistics, and treat a SQL
  front-end as a parser onto the same plan, never a second engine.
- **Parquet's remaining risk is drift, not coverage.** The golden fixtures
  pin behaviour against pyarrow today; keep regenerating them as the writers
  in the wild move, and keep unsupported codecs and encodings failing loudly
  rather than silently changing data.

## Sources

- Apache Arrow overview: https://arrow.apache.org/overview/
- Apache Arrow C Data Interface: https://arrow.apache.org/docs/format/CDataInterface.html
- Apache Parquet format: https://parquet.apache.org/docs/file-format/
- Apache Thrift compact protocol: https://github.com/apache/thrift/blob/master/doc/specs/thrift-compact-protocol.md
- Snappy format: https://github.com/google/snappy/blob/main/format_description.txt
- Hugging Face Datasets (the pipeline-maturity benchmark): https://huggingface.co/docs/datasets/index
