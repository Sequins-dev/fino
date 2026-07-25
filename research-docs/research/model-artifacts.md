# Fino Model Artifacts, Hub, and Tokenizers

> Status: research and direction-setting document.
>
> Parent: [typescript-model-factory.md](./typescript-model-factory.md) — the
> model-factory strategy. Siblings: [tensor-engine.md](./tensor-engine.md),
> [data-stack.md](./data-stack.md), [ml-workbench.md](./ml-workbench.md),
> [inference-serving.md](./inference-serving.md),
> [classical-ml.md](./classical-ml.md).
>
> Scope: the connection to the published-model ecosystem — artifact formats
> (safetensors, GGUF, npy/npz, config/tokenizer JSON), the model hub client
> with reproducible resolution, and tokenizers. Everything here is
> descriptor-producing and engine-independent: readers hand
> `{dtype, shape, byteRange}` descriptors to whatever materializes them
> ([tensor-engine.md](./tensor-engine.md) is the main consumer, but
> inspection and hub tooling stand alone).

## 1. Tokenizers — `fino:text/tokenizer`, pure TS

A reality check ruled out every native path: HuggingFace `tokenizers` is Rust
with no official C ABI, sentencepiece exposes C++ only, and llama.cpp's
tokenizer serves GGUF vocabs only (kept as an adapter). BPE/WordPiece over
`tokenizer.json` is string processing TS handles fine, and DataLoader workers
(see [data-stack.md](./data-stack.md)) parallelize dataset-scale tokenization
anyway. tiktoken format support is a cheap add; Unigram and BPE *training*
come later.

## 2. Model Hub — `fino:model/hub`

A HuggingFace Hub client on Fino's own HTTP stack: revision-resolving
downloads, resumable ranged fetches, sha256 verification, a content-addressed
cache (`blobs/sha256/<digest>` + per-repo manifests), and a project-level
**`models.lock`** pinning repo → commit → digests. Reproducible model
resolution as a default is something Python does not have. Bonus enabled by
safetensors: per-tensor byte offsets mean the client can fetch a *single
tensor* from a remote shard via HTTP Range — remote weight browsing without
downloading.

The same client resolves *dataset* repositories with the same
content-addressed cache and lockfile discipline; `fino:data`
([data-stack.md](./data-stack.md)) lists the hub as a source, and this is
the module that backs it.

## 3. Artifacts — `fino:model/artifacts`

Engine-agnostic safetensors (read/write), GGUF metadata (independent of
llama.cpp), npy/npz (near-free with `fino:archive`), config/tokenizer JSON
helpers; readers produce `{dtype, shape, byteRange}` descriptors the engine
materializes lazily, with sha256 integrity checks and a deterministic cache
layout.

Format positioning (from the parent's standards section): **safetensors** is
the near-term, high-leverage artifact format — metadata plus per-tensor byte
offsets, designed for safe, lazy, zero-copy-friendly loading. **ONNX** is the
portable graph format to read and (later) execute for inference interop —
never the internal training graph.

## 4. Adapters (PEFT)

Fine-tuned deltas, not full checkpoints, are how most useful weights ship.
Adopt the HuggingFace PEFT layout as the wire standard —
`adapter_model.safetensors` + `adapter_config.json` — for loading and
saving. This module owns the format side: adapter-only descriptors,
target-module mapping from the config, and merge/unmerge (baking LoRA deltas
into base weights to produce a plain safetensors, and the reverse) as
descriptor-level transforms. The `nn`-side mechanics — applying low-rank
deltas during forward — belong to `fino:tensor/nn`
([tensor-engine.md](./tensor-engine.md)).

## 5. ONNX Interop, Later

`fino:model/onnx` over ONNX Runtime's stable C API (`OrtApi`) for
exported-model inference interop — it also serves encoder models for
[inference-serving.md](./inference-serving.md). This is a Phase 5 breadth
item in the parent roadmap; artifact *inspection* of ONNX files (metadata,
tensor listings) can come earlier as part of `fino:model/artifacts`. Later
still, *export*: lowering the engine's recorded tape for small models to
ONNX for out-of-fino deployment. That direction is helped by the tape being
public API (`fino:tensor/graph`, see
[tensor-engine.md](./tensor-engine.md) §6) — export is a consumer of the
recorded graph like any other pass, not a privileged internal. ONNX remains
never the internal graph.

## 6. Sequencing

This doc's slice of the parent roadmap:

- **Phase 0 (in parallel with the engine spike; none of it waits on the
  engine):** the hub client and the tokenizer.
- **With the engine's Phase 1:** `fino:tensor/io` wires safetensors/GGUF/npy
  load-save to engine storage (the module itself is specced in
  [tensor-engine.md](./tensor-engine.md); the format readers live here). The
  PEFT adapter layout (§4) lands alongside it — adapters are the first
  fine-tuning wedge.
- **Product wedge served:** artifact-native inference and inspection —
  safetensors metadata browsing (including remote-by-Range), GGUF and ONNX
  inspection, loading a safetensors head into `fino:tensor/nn`. Connects Fino
  to real model repositories and keeps the tensor system from being toy-only.
- **Phase 5:** the ONNX Runtime adapter (§5); ONNX export from the recorded
  tape comes after, if interop pressure is real.

## Sources

- HuggingFace PEFT (the adapter-layout standard): https://huggingface.co/docs/peft
- Safetensors documentation: https://huggingface.co/docs/safetensors/index
- HuggingFace Hub API: https://huggingface.co/docs/hub/api
- Hugging Face Transformers (the artifact-ecosystem benchmark): https://huggingface.co/docs/transformers/index
- ONNX introduction: https://onnx.ai/onnx/intro/
- ONNX Runtime C API: https://onnxruntime.ai/docs/api/c/
