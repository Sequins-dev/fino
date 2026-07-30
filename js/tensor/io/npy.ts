/**
 * The NumPy `.npy` container.
 *
 * Supported because it is what a fixture generator, a debugging session, and a
 * comparison against another framework all reach for: one array, a header naming its
 * dtype and shape, then raw bytes. Like safetensors, the bytes are already in the
 * layout a device wants, so loading is a read rather than a decode.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor/io`; import from there.
 */
import { DiskFileSystem } from 'fino:file';
import type { DType } from '../dtype.ts';
import { DTYPE_BYTES } from '../dtype.ts';
import type { Device } from '../backend.ts';
import { resolveDevice } from '../backend.ts';
import { fromHostBytes } from '../create.ts';
import { numel } from '../shape.ts';
import { readBytes } from '../readback.ts';
import type { Tensor } from '../tensor.ts';

/** The six bytes every `.npy` file starts with. */
const MAGIC = new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]);

/**
 * NumPy type strings mapped to this engine's dtypes.
 *
 * Only little-endian entries appear. A big-endian array would need every element
 * byte-swapped, which defeats the point of a format whose bytes can be uploaded
 * as-is; such a file is rejected with an explanation rather than handled slowly.
 *
 * `bf16` is absent because NumPy has no such dtype — it is not an oversight to fix
 * here but a fact about the format.
 */
const DESCR_TO_DTYPE: Readonly<Record<string, DType>> = {
  '<f8': 'f64',
  '<f4': 'f32',
  '<f2': 'f16',
  '<i8': 'i64',
  '<i4': 'i32',
  '|u1': 'u8',
  '|b1': 'bool',
  // NumPy writes single-byte types with either an ignored or an absent byte order.
  '<u1': 'u8',
  '<b1': 'bool',
};

/** This engine's dtypes mapped back to NumPy type strings. */
const DTYPE_TO_DESCR: Readonly<Record<DType, string | null>> = {
  f64: '<f8',
  f32: '<f4',
  f16: '<f2',
  bf16: null,
  i64: '<i8',
  i32: '<i4',
  u8: '|u1',
  bool: '|b1',
};

/** Read a `.npy` file onto a device. */
export async function loadNpy(
  path: string,
  options: { device?: 'auto' | string | Device } = {},
): Promise<Tensor> {
  const fs = new DiskFileSystem();
  const bytes = await fs.readFile(path);
  const { dtype, shape, dataStart } = parseHeader(bytes, path);
  const expected = numel(shape) * DTYPE_BYTES[dtype];
  const available = bytes.length - dataStart;
  if (available < expected) {
    throw new Error(
      `${path} is truncated: shape [${shape.join(', ')}] of ${dtype} needs ${expected} bytes, ${available} remain`,
    );
  }
  const device = await resolveDevice(options.device ?? 'auto');
  return fromHostBytes(bytes.subarray(dataStart, dataStart + expected), shape, dtype, device);
}

/**
 * Parse the header, returning where the data begins.
 *
 * @internal
 */
function parseHeader(
  bytes: Uint8Array,
  path: string,
): { dtype: DType; shape: number[]; dataStart: number } {
  if (bytes.length < 10 || !MAGIC.every((byte, i) => bytes[i] === byte)) {
    throw new Error(`${path} does not start with the NumPy magic prefix`);
  }
  const major = bytes[6]!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Version 1 writes a two-byte header length; 2 and 3 write four. The rest of the
  // header is identical, so only the prefix width differs.
  const lengthBytes = major === 1 ? 2 : 4;
  if (major < 1 || major > 3) {
    throw new Error(`${path} is .npy version ${major}, which is not supported`);
  }
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const dataStart = 8 + lengthBytes + headerLength;
  if (dataStart > bytes.length) {
    throw new Error(`${path} has a header longer than the file`);
  }
  const header = new TextDecoder().decode(bytes.subarray(8 + lengthBytes, dataStart));

  // The header is a Python dict literal. Matching the three keys is more robust here
  // than a general literal parser, which would have to handle quoting rules that
  // NumPy never exercises.
  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
  if (!descr) throw new Error(`${path} has no 'descr' in its header`);
  const dtype = DESCR_TO_DTYPE[descr];
  if (!dtype) {
    const hint = descr.startsWith('>')
      ? 'big-endian arrays are not supported; re-save it little-endian'
      : 'this engine has no matching dtype';
    throw new Error(`${path} has NumPy dtype '${descr}': ${hint}`);
  }

  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(header)?.[1];
  if (fortran === 'True') {
    throw new Error(
      `${path} is in Fortran order; this engine is row-major, so re-save it with a C-order array`,
    );
  }

  const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  if (shapeText === undefined) throw new Error(`${path} has no 'shape' in its header`);
  const shape = shapeText
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const size = Number(part);
      if (!Number.isInteger(size) || size < 0) {
        throw new Error(`${path} has a malformed shape entry '${part}'`);
      }
      return size;
    });

  return { dtype, shape, dataStart };
}

/**
 * Write a tensor as a `.npy` file.
 *
 * Version 1.0 with the header padded to a 64-byte boundary, which is what NumPy
 * itself writes and what its loader's alignment expectations assume.
 */
export async function saveNpy(path: string, tensor: Tensor): Promise<void> {
  const descr = DTYPE_TO_DESCR[tensor.dtype];
  if (!descr) {
    throw new Error(`cannot write ${tensor.dtype} as .npy: NumPy has no matching dtype`);
  }
  // A one-element trailing comma is required for rank 1, and harmless above it: NumPy
  // writes `(3,)` for a vector because `(3)` is not a Python tuple.
  const shape = tensor.shape.length === 0 ? '()' : `(${tensor.shape.join(', ')},)`;
  const dict = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${shape}, }`;

  const prefixLength = 10;
  const padded = new TextEncoder().encode(dict);
  const unpadded = prefixLength + padded.length + 1;
  const padding = (64 - (unpadded % 64)) % 64;
  const header = new TextEncoder().encode(dict + ' '.repeat(padding) + '\n');

  const head = new Uint8Array(prefixLength);
  head.set(MAGIC, 0);
  head[6] = 1;
  head[7] = 0;
  new DataView(head.buffer).setUint16(8, header.length, true);

  const body = await readBytes(tensor);
  const out = new Uint8Array(head.length + header.length + body.length);
  out.set(head, 0);
  out.set(header, head.length);
  out.set(body, head.length + header.length);

  const fs = new DiskFileSystem();
  await fs.writeFile(path, out);
}
