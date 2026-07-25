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

Data is Arrow-first and streaming-first. `fino:data/arrow` already provides
the Arrow substrate (below); the remaining pieces are a native Parquet
module, a query/DataFrame layer, and a Dataset/DataLoader, each of which
builds on it.

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
- **`fino:format/thrift` — generic Thrift codec (planned).** Parquet's file
  metadata (`FileMetaData`, `RowGroup`, `ColumnChunk`, `Statistics`, …) is
  serialized with Thrift's compact protocol. Like flatbuffers, Thrift is a
  general-purpose format that belongs in its own module, not buried in a
  Parquet reader — a schema-less compact-protocol reader/writer that any
  consumer can use.
- **`fino:compress` + Snappy (planned).** Parquet's default page codec is
  Snappy; gzip/brotli/zstd/lz4 (which Parquet also permits) already exist.
  Snappy is a small, well-specified block format — add it to the existing
  generic compress module, not to Parquet internals.
- **`fino:data/parquet` — native Parquet (planned).** Built on
  `fino:format/thrift` + `fino:compress` + `fino:data/arrow`: read and write
  the full column layout (the ~8 encodings — plain, RLE/bit-packed dictionary,
  delta, delta-length/byte-array, byte-stream-split — plus page compression,
  statistics, and nested/repetition-and-definition levels), producing and
  consuming Arrow record batches. This is real work, but it is *bounded* work
  in discrete modules whose generic parts (Thrift, Snappy) are reusable — the
  opposite of importing a multi-feature engine to get one format.
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

- **Phase 0 (in parallel with the engine spike; none of it waits on the
  engine):** `fino:format/thrift`, Snappy in `fino:compress`,
  `fino:data/parquet`.
- **Then:** `fino:data/frame` and `fino:data` (Dataset/DataLoader), which the
  training loop and `fino:ai/eval` consume.
- **Phase 3 slice:** DataLoader hardening — worker-pool pipeline, prefetch
  into the engine's pinned H2D ring, and `state()`/`restore()` integration
  with `fino:workflow` checkpointing (surfaced in
  [ml-workbench.md](./ml-workbench.md)).
- Vision datasets eventually need `fino:media/image` (decode via system
  jpeg-turbo/libpng) plus augmentation transforms — random crop/flip/color
  jitter as DataLoader-stage tensor ops running on the worker pool; that
  lives in the parent roadmap's later items.

## 4. Risks and Open Questions

- **Native Parquet is bounded but not small.** Full encoding coverage (the ~8
  encodings, nested repetition/definition levels, statistics) is the effort;
  keep it honest by building the reusable generics (`fino:format/thrift`,
  Snappy) first and differentially testing `fino:data/parquet` against files
  written by pyarrow/parquet-tools, the way Arrow is tested against pyarrow.

## Sources

- Apache Arrow overview: https://arrow.apache.org/overview/
- Apache Arrow C Data Interface: https://arrow.apache.org/docs/format/CDataInterface.html
- Apache Parquet format: https://parquet.apache.org/docs/file-format/
- Apache Thrift compact protocol: https://github.com/apache/thrift/blob/master/doc/specs/thrift-compact-protocol.md
- Snappy format: https://github.com/google/snappy/blob/main/format_description.txt
- Hugging Face Datasets (the pipeline-maturity benchmark): https://huggingface.co/docs/datasets/index
