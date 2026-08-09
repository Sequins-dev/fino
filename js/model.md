---
weight: 146
---

# Models

`fino:model/hub` resolves models and datasets from a Hugging Face-compatible hub
onto local disk, reproducibly. It runs on Fino's own HTTP stack, verifies every
byte it stores, and pins what it resolved in a project lockfile.

## Why a lockfile

A revision like `main` is a moving target. A script that loads a model by
revision can load different weights tomorrow with nothing in the repository
recording that anything changed — which makes an evaluation result impossible to
reproduce and a regression impossible to attribute.

`models.lock` closes that: it records the commit each revision resolved to and
the sha256 of every file fetched from it. Later runs resolve through the lock
instead of the network, and fail loudly if the bytes they get back are not the
bytes that were pinned. Reproducible model resolution as a default is something
the Python ecosystem does not give you.

```ts no_run
import { HubClient } from 'fino:model/hub';

const hub = new HubClient({ lockfile: './models.lock' });
const file = await hub.download({ repo: 'bert-base-uncased' }, 'tokenizer.json');

console.log(file.commit); // the commit `main` resolved to
console.log(file.sha256); // the digest of what landed
console.log(file.path);   // where in the cache it landed
```

The lockfile is JSON with sorted keys and a trailing newline, so it diffs cleanly
and belongs in version control. Its shape is:

```json
{
  "version": 1,
  "entries": {
    "model:bert-base-uncased@main": {
      "type": "model",
      "repo": "bert-base-uncased",
      "revision": "main",
      "commit": "<the 40-character commit main resolved to>",
      "files": {
        "tokenizer.json": { "size": 466247, "sha256": "…" }
      }
    }
  }
}
```

Once a revision is pinned, `resolveRevision` answers from the lock and costs no
request. To move a pin forward, pass `update`:

```ts no_run
await hub.download({ repo: 'bert-base-uncased' }, 'tokenizer.json', { update: true });
```

## Whole revisions

`snapshot` fetches a revision's files concurrently and writes one pin at the end,
so a multi-file fetch either pins the set it fetched or leaves the previous pin
alone. `allow` and `ignore` keep large files out of a fetch that does not need
them:

```ts no_run
const snapshot = await hub.snapshot(
  { repo: 'bert-base-uncased' },
  { allow: ['.json', '.txt'], ignore: [/^onnx\//] },
);
console.log(snapshot.files.map((file) => file.name));
```

`listFiles` reports names, sizes, and — for LFS-tracked files — content digests
without downloading anything, which is enough to decide what is worth fetching
before any bytes move.

## The cache

Files are stored by digest, not by path: `blobs/sha256/<ab>/<cd>/<digest>`. Two
revisions that share a `config.json` share one blob, and a re-download that
produces the same bytes is a no-op. Per-repo manifests under
`manifests/models/<owner>--<name>/<commit>.json` map `repo@commit/path` back onto
the blobs, which keeps the blob store free of naming decisions and makes it safe
to prune by digest.

Every path is derived rather than invented, so two processes on the same machine
agree on where a file lives without coordinating — including the partial file of
an in-flight transfer, which is how a restarted process finds and resumes its own
download instead of starting over.

The root is `FINO_MODEL_CACHE` if set, then `$HF_HOME/fino`, then
`$XDG_CACHE_HOME/fino/models`, then `~/.cache/fino/models`. `HF_TOKEN` (or
`HUGGING_FACE_HUB_TOKEN`) supplies the bearer token for private repositories.

## Transfers

Model weights are large enough that a failed transfer has to resume rather than
restart. A download writes to its partial file and, on retry, requests
`bytes=<n>-` from where it stopped. The sha256 is computed as the bytes stream
past — never by re-reading the finished file — and on resume the bytes already on
disk are replayed through the digest first, so the hash covers the whole file even
though the transfer did not.

A server that ignores `Range` and answers `200` is handled by starting over
rather than by appending, which would corrupt the file silently.

```ts no_run
await hub.download({ repo: 'bert-base-uncased' }, 'model.safetensors', {
  onProgress: ({ path, transferred, total }) => {
    console.log(path, transferred, total);
  },
});
```

A digest that disagrees with what is pinned raises an `IntegrityError` carrying
both digests.

## Datasets

The same client resolves dataset repositories through the same cache and lockfile
discipline — pass `type: 'dataset'`. Model and dataset namespaces do not collide.

```ts no_run
const rows = await hub.download(
  { repo: 'squad', type: 'dataset', revision: 'main' },
  'plain_text/train-00000-of-00001.parquet',
);
```

For streaming a dataset file straight into a pipeline without caching it, see
`hubDataset` in the [Data guide](./data.md).

## Offline and verification

`offline: true` never touches the network and serves only what is cached, which
is what makes a locked project buildable in a sandbox with no egress. `verify`
re-hashes every pinned blob rather than trusting its filename, so a blob that was
truncated or edited in place is reported instead of served:

```ts no_run
const report = await hub.verify();
console.log(report.ok.length, report.missing, report.corrupt);
```
