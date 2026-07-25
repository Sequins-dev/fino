# Fino Data Stack — Remaining Work

> Status: research and direction-setting document.
>
> Parent: [typescript-model-factory.md](./typescript-model-factory.md) — the
> model-factory strategy. Siblings: [tensor-engine.md](./tensor-engine.md),
> [model-artifacts.md](./model-artifacts.md),
> [ml-workbench.md](./ml-workbench.md),
> [inference-serving.md](./inference-serving.md), and
> [classical-ml.md](./classical-ml.md).
>
> Scope: the query/DataFrame layer and Dataset/DataLoader pipeline that remain
> above Fino's implemented Arrow and Parquet stack.

## 1. Current Baseline

The standards and file-format foundation is implemented:

- `fino:data/arrow` covers Arrow logical types, vectors, record batches,
  tables, IPC stream/file formats, compression, and the C Data Interface.
- `internal:format/thrift` provides the binary, compact, and JSON protocol
  codecs used by Parquet.
- `fino:compress` includes Snappy raw blocks alongside gzip/deflate, Brotli,
  Zstandard, and LZ4.
- `fino:data/parquet` reads and writes Arrow tables/record batches with full
  type, encoding, page-version, compression, statistics, and nested Dremel
  coverage. Golden fixtures verify interoperability with PyArrow.

The remaining stack should stay Arrow-first and streaming-first. Do not adopt a
bundled query engine merely to obtain DataFrame or dataset behavior: the
runtime already owns the reusable format and compression layers.

## 2. DataFrame Over Arrow

Add `fino:data/frame` as a lazy expression plan executed directly over Arrow
record batches. The initial bounded operator set is:

- filter and projection;
- `groupBy` and aggregation;
- joins;
- sort and limit;
- reusable scalar/column expressions for preprocessing.

Execution should use vectorized column kernels rather than row objects. The
Parquet integration should push required columns and predicates into scans,
skip row groups from statistics, and stream record batches instead of loading
whole files when the input permits random access.

If a SQL surface is added later, it parses into the same plan. It must not
introduce a second execution engine.

## 3. Dataset And DataLoader

Add the public `fino:data` pipeline abstractions:

- `Dataset` for deterministic random access;
- `IterableDataset` for async streaming sources;
- `map`, `filter`, buffered `shuffle`, `batch`, `take`, deterministic `split`,
  and `interleave`;
- sources for CSV/JSONL, Arrow IPC, Parquet, SQLite, HTTP/storage, and the model
  hub when it lands;
- collators that produce Arrow batches first and tensor descriptors only at the
  tensor boundary.

`DataLoader` should parallelize decode, augmentation, and tokenization with
ordinary realms composed through `RealmDeployment`. Workers write collated
batches into SharedArrayBuffer slabs; consumers receive descriptors rather
than structured-cloned payload copies.

Determinism is part of the contract. One seed derives per-epoch and per-worker
streams, while `state()`/`restore()` records source position, shuffle state,
epoch, and outstanding batch order so `fino:workflow` can checkpoint mid-epoch.

## 4. Tensor And Media Boundaries

Arrow record batches remain the tabular currency; tensors are the numeric
currency. `column.toTensor()` is the explicit crossing point once
`fino:tensor` exists. Preserve zero-copy or bounded-copy behavior explicitly
and expose it in diagnostics rather than hiding conversions.

Vision datasets later need `fino:media/image` over system jpeg-turbo/libpng
plus seeded crop/flip/color transforms. Decode and augmentation belong in the
DataLoader worker stage, not in the DataFrame engine.

## 5. Delivery Order

1. Define the DataFrame expression and streaming execution contracts over
   Arrow batches.
2. Implement projection/filter plus Parquet column and row-group pushdown.
3. Add aggregation, join, sort, and preprocessing expressions.
4. Add deterministic Dataset/IterableDataset transformations and built-in
   sources.
5. Add RealmDeployment-backed DataLoader workers and SharedArrayBuffer
   collation.
6. Add `state()`/`restore()` and workflow checkpoint/resume coverage.
7. Integrate pinned host-to-device prefetch only after the tensor engine
   exposes the required storage contract.

## 6. Required Tests

- expression results match a simple row-wise oracle across nulls and Arrow
  logical types;
- projected Parquet scans avoid decoding unused columns;
- predicate statistics skip only row groups proven not to match;
- streaming plans keep memory bounded across large inputs;
- the same seed yields the same split, shuffle, and batch order;
- save/restore resumes without duplication or omission;
- worker failures and cancellation release realms and shared slabs;
- zero-copy versus bounded-copy crossings are observable and tested.

## Sources

- Apache Arrow overview: https://arrow.apache.org/overview/
- Apache Arrow C Data Interface: https://arrow.apache.org/docs/format/CDataInterface.html
- Apache Parquet format: https://parquet.apache.org/docs/file-format/
- Hugging Face Datasets: https://huggingface.co/docs/datasets/index
