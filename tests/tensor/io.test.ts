/**
 * Reading and writing tensor files.
 *
 * Round trips are the main check: a file this engine writes and reads back must
 * agree, and a file written by the reference implementation of each format must load.
 * Byte-level fixtures are built here rather than committed, so a failure points at the
 * parser rather than at a stale binary blob.
 */
import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { device, tensor, zeros } from 'fino:tensor';
import type { Device } from 'fino:tensor';
import {
  loadNpy,
  loadSafetensors,
  openSafetensors,
  saveNpy,
  saveSafetensors,
} from 'fino:tensor/io';
import { Linear, Sequential } from 'fino:tensor/nn';

const fs = new DiskFileSystem();

/** A scratch path unique to each call, so no two cases can collide. */
let scratchCounter = 0;
function scratch(name: string): string {
  return `/tmp/fino-tensor-io-${name}-${scratchCounter++}`;
}

/** Build a safetensors file byte by byte, the way another writer would. */
function buildSafetensors(
  header: Record<string, unknown>,
  data: Uint8Array,
): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + headerBytes.length + data.length);
  new DataView(out.buffer).setBigUint64(0, BigInt(headerBytes.length), true);
  out.set(headerBytes, 8);
  out.set(data, 8 + headerBytes.length);
  return out;
}

describe('safetensors', () => {
  it('round trips a state dictionary', async (t) => {
    const path = scratch('roundtrip');
    const a = await tensor([[1.5, -2.5, 3.5], [4.5, 5.5, 6.5]]);
    const b = await tensor([7, 8], { dtype: 'i32' });
    try {
      await saveSafetensors(path, new Map([['w', a], ['bias', b]]), { format: 'test' });
      const loaded = await loadSafetensors(path, { device: await device('cpu') });
      t.deepEqual([...loaded.keys()].sort(), ['bias', 'w'], 'both tensors come back');
      t.deepEqual([...loaded.get('w')!.shape], [2, 3], 'the shape survives');
      t.equal(loaded.get('bias')!.dtype, 'i32', 'the dtype survives');
      t.deepEqual(
        Array.from(await loaded.get('w')!.data()),
        [1.5, -2.5, 3.5, 4.5, 5.5, 6.5],
        'and so do the values',
      );
      t.deepEqual(Array.from(await loaded.get('bias')!.data()), [7, 8], 'including integers');
      for (const value of loaded.values()) value.dispose();
    } finally {
      a.dispose();
      b.dispose();
      await fs.unlink(path).catch(() => {});
    }
  });

  it('preserves half-precision bits exactly', async (t) => {
    const path = scratch('half');
    const x = await tensor([0.1, -0.2, 65504], { dtype: 'f16' });
    try {
      const before = [...(await x.data())];
      await saveSafetensors(path, new Map([['x', x]]));
      const loaded = await loadSafetensors(path, { device: await device('cpu') });
      t.equal(loaded.get('x')!.dtype, 'f16', 'the dtype is not widened on the way through');
      t.deepEqual([...(await loaded.get('x')!.data())], before, 'and no value is re-rounded');
      loaded.get('x')!.dispose();
    } finally {
      x.dispose();
      await fs.unlink(path).catch(() => {});
    }
  });

  it('reads a file written by another implementation', async (t) => {
    // Two f32 tensors laid out back to back, with the metadata key present and the
    // names deliberately out of order — none of which a reader may depend on.
    const path = scratch('foreign');
    const data = new Uint8Array(6 * 4);
    new Float32Array(data.buffer).set([1, 2, 3, 4, 5, 6]);
    const file = buildSafetensors(
      {
        __metadata__: { framework: 'pt' },
        second: { dtype: 'F32', shape: [2], data_offsets: [16, 24] },
        first: { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] },
      },
      data,
    );
    try {
      await fs.writeFile(path, file);
      const opened = await openSafetensors(path);
      t.equal(opened.metadata.framework, 'pt', 'metadata is exposed, not treated as a tensor');
      t.deepEqual(
        opened.list().map((info) => info.name).sort(),
        ['first', 'second'],
        'and is not listed among the tensors',
      );
      const first = await opened.read('first', await device('cpu'));
      const second = await opened.read('second', await device('cpu'));
      t.deepEqual(Array.from(await first.data()), [1, 2, 3, 4], 'the first tensor');
      t.deepEqual(Array.from(await second.data()), [5, 6], 'the second tensor');
      first.dispose();
      second.dispose();
      await opened.close();
    } finally {
      await fs.unlink(path).catch(() => {});
    }
  });

  it('loads only the names asked for', async (t) => {
    const path = scratch('subset');
    const a = await tensor([1, 2]);
    const b = await tensor([3, 4]);
    try {
      await saveSafetensors(path, new Map([['a', a], ['b', b]]));
      const loaded = await loadSafetensors(path, {
        names: ['b'],
        device: await device('cpu'),
      });
      t.deepEqual([...loaded.keys()], ['b'], 'only the requested tensor is read');
      loaded.get('b')!.dispose();
    } finally {
      a.dispose();
      b.dispose();
      await fs.unlink(path).catch(() => {});
    }
  });

  it('rejects a malformed file rather than loading it wrong', async (t) => {
    const cases: { name: string; file: Uint8Array; pattern: RegExp }[] = [
      {
        name: 'a header length larger than any real model',
        file: (() => {
          const out = new Uint8Array(16);
          new DataView(out.buffer).setBigUint64(0, 1n << 40n, true);
          return out;
        })(),
        pattern: /not plausible/,
      },
      {
        name: 'a header that is not JSON',
        file: (() => {
          const body = new TextEncoder().encode('not json');
          const out = new Uint8Array(8 + body.length);
          new DataView(out.buffer).setBigUint64(0, BigInt(body.length), true);
          out.set(body, 8);
          return out;
        })(),
        pattern: /not valid JSON/,
      },
      {
        name: 'a dtype this engine cannot represent',
        file: buildSafetensors(
          { x: { dtype: 'U16', shape: [2], data_offsets: [0, 4] } },
          new Uint8Array(4),
        ),
        pattern: /cannot represent/,
      },
      {
        name: 'a byte range that disagrees with the shape',
        file: buildSafetensors(
          { x: { dtype: 'F32', shape: [4], data_offsets: [0, 8] } },
          new Uint8Array(8),
        ),
        pattern: /needs 16/,
      },
      {
        name: 'a byte range past the end of the file',
        file: buildSafetensors(
          { x: { dtype: 'F32', shape: [8], data_offsets: [0, 32] } },
          new Uint8Array(8),
        ),
        pattern: /data section holds/,
      },
    ];
    for (const { name, file, pattern } of cases) {
      const path = scratch('bad');
      await fs.writeFile(path, file);
      try {
        await t.rejects(() => openSafetensors(path), pattern, `refuses ${name}`);
      } finally {
        await fs.unlink(path).catch(() => {});
      }
    }
  });

  it('names a missing tensor rather than returning nothing', async (t) => {
    const path = scratch('missing');
    const x = await tensor([1]);
    try {
      await saveSafetensors(path, new Map([['present', x]]));
      const opened = await openSafetensors(path);
      t.ok(!opened.has('absent'), 'has() reports the absence');
      await t.rejects(() => opened.read('absent'), /no tensor named 'absent'/, 'read explains it');
      await opened.close();
    } finally {
      x.dispose();
      await fs.unlink(path).catch(() => {});
    }
  });

  it('carries a model through a save and load', async (t) => {
    const path = scratch('model');
    const target: Device = await device('auto');
    const model = new Sequential(new Linear(4, 3), new Linear(3, 2));
    const restored = new Sequential(new Linear(4, 3), new Linear(3, 2));
    const x = await tensor([1, 2, 3, 4], { shape: [1, 4], device: target });
    try {
      await saveSafetensors(path, model.stateDict());
      const weights = await loadSafetensors(path, { device: target });
      restored.loadStateDict(weights);
      t.deepEqual(
        Array.from(await restored.forward(x).data()),
        Array.from(await model.forward(x).data()),
        'the restored model computes what the saved one did',
      );
      for (const value of weights.values()) value.dispose();
    } finally {
      model.dispose();
      restored.dispose();
      x.dispose();
      await fs.unlink(path).catch(() => {});
    }
  });
});

describe('npy', () => {
  it('round trips shapes and dtypes', async (t) => {
    for (const dtype of ['f32', 'f64', 'f16', 'i32', 'u8'] as const) {
      const path = scratch(`npy-${dtype}`);
      // f64 lives only on the CPU, so this whole case is pinned there rather than
      // running some dtypes on the default device and some not.
      const x = await tensor([1, 2, 3, 4, 5, 6], {
        shape: [2, 3],
        dtype,
        device: await device('cpu'),
      });
      try {
        const before = [...(await x.data())];
        await saveNpy(path, x);
        const loaded = await loadNpy(path, { device: await device('cpu') });
        t.equal(loaded.dtype, dtype, `${dtype} survives the round trip`);
        t.deepEqual([...loaded.shape], [2, 3], `the shape survives for ${dtype}`);
        t.deepEqual([...(await loaded.data())], before, `the values survive for ${dtype}`);
        loaded.dispose();
      } finally {
        x.dispose();
        await fs.unlink(path).catch(() => {});
      }
    }
  });

  it('round trips a rank-one and a rank-zero array', async (t) => {
    // NumPy writes `(3,)` for a vector and `()` for a scalar; both have to parse.
    for (const shape of [[3], []]) {
      const path = scratch(`npy-rank${shape.length}`);
      const x = await zeros(shape, { device: await device('cpu') });
      try {
        await saveNpy(path, x);
        const loaded = await loadNpy(path, { device: await device('cpu') });
        t.deepEqual([...loaded.shape], shape, `rank ${shape.length} survives`);
        loaded.dispose();
      } finally {
        x.dispose();
        await fs.unlink(path).catch(() => {});
      }
    }
  });

  it('pads the header the way NumPy does', async (t) => {
    const path = scratch('npy-align');
    const x = await tensor([1, 2, 3]);
    try {
      await saveNpy(path, x);
      const bytes = await fs.readFile(path);
      const headerLength = new DataView(bytes.buffer, bytes.byteOffset).getUint16(8, true);
      t.equal((10 + headerLength) % 64, 0, 'the data begins on a 64-byte boundary');
      t.equal(bytes[10 + headerLength - 1], 0x0a, 'and the header ends with a newline');
    } finally {
      x.dispose();
      await fs.unlink(path).catch(() => {});
    }
  });

  it('rejects files it cannot load as written', async (t) => {
    const header = (dict: string): Uint8Array => {
      const body = new TextEncoder().encode(dict.padEnd(54) + '\n');
      const out = new Uint8Array(10 + body.length + 16);
      out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
      new DataView(out.buffer).setUint16(8, body.length, true);
      out.set(body, 10);
      return out;
    };
    const cases: { name: string; file: Uint8Array; pattern: RegExp }[] = [
      {
        name: 'a file without the magic prefix',
        file: new Uint8Array(32),
        pattern: /magic prefix/,
      },
      {
        name: 'a big-endian array',
        file: header(`{'descr': '>f4', 'fortran_order': False, 'shape': (4,), }`),
        pattern: /big-endian/,
      },
      {
        name: 'a Fortran-order array',
        file: header(`{'descr': '<f4', 'fortran_order': True, 'shape': (4,), }`),
        pattern: /Fortran order/,
      },
    ];
    for (const { name, file, pattern } of cases) {
      const path = scratch('npy-bad');
      await fs.writeFile(path, file);
      try {
        await t.rejects(() => loadNpy(path), pattern, `refuses ${name}`);
      } finally {
        await fs.unlink(path).catch(() => {});
      }
    }
  });

  it('refuses to write a dtype NumPy has no name for', async (t) => {
    const x = await tensor([1, 2], { dtype: 'bf16' });
    try {
      await t.rejects(
        () => saveNpy(scratch('npy-bf16'), x),
        /no matching dtype/,
        'bf16 is refused rather than written as something else',
      );
    } finally {
      x.dispose();
    }
  });
});
