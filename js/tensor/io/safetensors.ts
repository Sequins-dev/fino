/**
 * The safetensors container.
 *
 * A length-prefixed JSON header naming every tensor, followed by their raw bytes
 * in the layout a device wants: row-major, contiguous, little-endian. That is why
 * this format is worth supporting directly — a tensor's bytes go from the file to
 * device memory without a decode step, so loading is bounded by I/O rather than by
 * conversion.
 *
 * Tensors are read one at a time through positional reads rather than by loading the
 * file, because a weight file is routinely larger than the memory available to hold
 * both it and the model.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor/io`; import from there.
 */
import { DiskFileSystem } from 'fino:file';
import type { File } from 'fino:file';
import type { DType } from '../dtype.ts';
import { DTYPE_BYTES } from '../dtype.ts';
import type { Device } from '../backend.ts';
import { resolveDevice } from '../backend.ts';
import { fromHostBytes } from '../create.ts';
import { numel } from '../shape.ts';
import { readBytes } from '../readback.ts';
import type { Tensor } from '../tensor.ts';

/**
 * Largest header this will parse, as a guard against a corrupt length prefix.
 *
 * The prefix is the first thing read and is trusted for the allocation that follows,
 * so a garbage value would otherwise ask for an arbitrary amount of memory. Real
 * headers are a few hundred bytes per tensor; 100MB is far above any plausible model
 * and far below a denial of service.
 */
const MAX_HEADER_BYTES = 100 * 1024 * 1024;

/**
 * safetensors dtype names mapped to this engine's.
 *
 * The absent ones are absent deliberately: `I8`, `I16`, `U16`, `U32`, `U64`, and the
 * two 8-bit float formats have no representation here, and inventing one silently
 * would produce a model that loads and is wrong.
 */
const DTYPE_NAMES: Readonly<Record<string, DType>> = {
  BOOL: 'bool',
  U8: 'u8',
  F16: 'f16',
  BF16: 'bf16',
  F32: 'f32',
  F64: 'f64',
  I32: 'i32',
  I64: 'i64',
};

/** This engine's dtypes mapped back to safetensors names. */
const NAMES_BY_DTYPE: Readonly<Record<DType, string>> = {
  bool: 'BOOL',
  u8: 'U8',
  f16: 'F16',
  bf16: 'BF16',
  f32: 'F32',
  f64: 'F64',
  i32: 'I32',
  i64: 'I64',
};

/** One tensor's entry in the header. */
interface HeaderEntry {
  dtype: string;
  shape: number[];
  data_offsets: [number, number];
}

/** What a tensor in the file is, without its values. */
export interface TensorInfo {
  name: string;
  dtype: DType;
  shape: number[];
  /** Bytes the tensor occupies. */
  byteLength: number;
}

/** How {@link loadSafetensors} behaves. */
export interface LoadOptions {
  /** Where to put the tensors. Defaults to `'auto'`. */
  device?: 'auto' | string | Device;
  /** Load only these names. Defaults to all of them. */
  names?: readonly string[];
}

/**
 * A weight file opened for reading, tensor by tensor.
 *
 * Holds the header and an open descriptor, so inspecting a checkpoint costs one
 * small read and loading a tensor costs exactly that tensor. Close it when done —
 * or use {@link loadSafetensors}, which closes it for you.
 */
export class SafetensorsFile {
  /**
   * @internal
   */
  #file: File;

  /**
   * @internal
   */
  #entries: Map<string, HeaderEntry>;

  /**
   * Byte position the data section starts at, which every entry's offsets are
   * relative to.
   *
   * @internal
   */
  #dataStart: number;

  /**
   * @internal
   */
  #metadata: Readonly<Record<string, string>>;

  /**
   * @internal
   */
  constructor(
    file: File,
    entries: Map<string, HeaderEntry>,
    dataStart: number,
    metadata: Readonly<Record<string, string>>,
  ) {
    this.#file = file;
    this.#entries = entries;
    this.#dataStart = dataStart;
    this.#metadata = metadata;
  }

  /** The file's free-form metadata, from the header's `__metadata__` key. */
  get metadata(): Readonly<Record<string, string>> {
    return this.#metadata;
  }

  /** Every tensor in the file, in header order. */
  list(): TensorInfo[] {
    return [...this.#entries].map(([name, entry]) => ({
      name,
      dtype: DTYPE_NAMES[entry.dtype]!,
      shape: [...entry.shape],
      byteLength: entry.data_offsets[1] - entry.data_offsets[0],
    }));
  }

  /** Whether the file holds a tensor under this name. */
  has(name: string): boolean {
    return this.#entries.has(name);
  }

  /** Read one tensor onto a device. */
  async read(name: string, device: 'auto' | string | Device = 'auto'): Promise<Tensor> {
    const entry = this.#entries.get(name);
    if (!entry) {
      throw new Error(`safetensors file has no tensor named '${name}'`);
    }
    const dtype = DTYPE_NAMES[entry.dtype]!;
    const [start, end] = entry.data_offsets;
    const length = end - start;
    const bytes = await this.#file.pread(this.#dataStart + start, length);
    if (bytes.length !== length) {
      throw new Error(
        `tensor '${name}' is truncated: expected ${length} bytes at ${start}, read ${bytes.length}`,
      );
    }
    return fromHostBytes(bytes, entry.shape, dtype, await resolveDevice(device));
  }

  /** Release the descriptor. */
  async close(): Promise<void> {
    await this.#file.close();
  }
}

/**
 * Open a safetensors file and parse its header.
 *
 * The header is validated up front — dtypes, shapes, and the byte ranges they claim
 * — so a malformed file fails before any tensor is allocated rather than partway
 * through loading a model.
 */
export async function openSafetensors(path: string): Promise<SafetensorsFile> {
  const fs = new DiskFileSystem();
  const file = await fs.open(path, 'r');
  try {
    const prefix = await file.pread(0, 8);
    if (prefix.length < 8) {
      throw new Error('file is shorter than a safetensors header prefix');
    }
    const headerLength = Number(
      new DataView(prefix.buffer, prefix.byteOffset, 8).getBigUint64(0, true),
    );
    if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES) {
      throw new Error(
        `header length ${headerLength} is not plausible; the file is probably not safetensors`,
      );
    }
    const headerBytes = await file.pread(8, headerLength);
    if (headerBytes.length !== headerLength) {
      throw new Error(`header is truncated: expected ${headerLength} bytes`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(new TextDecoder().decode(headerBytes)) as Record<string, unknown>;
    } catch (cause) {
      throw new Error(`safetensors header is not valid JSON: ${(cause as Error).message}`);
    }

    let metadata: Record<string, string> = {};
    const entries = new Map<string, HeaderEntry>();
    const fileSize = Number(await file.size());
    const dataStart = 8 + headerLength;

    for (const [name, value] of Object.entries(parsed)) {
      if (name === '__metadata__') {
        metadata = (value ?? {}) as Record<string, string>;
        continue;
      }
      entries.set(name, checkEntry(name, value, fileSize - dataStart));
    }

    return new SafetensorsFile(file, entries, dataStart, metadata);
  } catch (cause) {
    await file.close();
    throw cause;
  }
}

/**
 * Validate one header entry against the file it claims to describe.
 *
 * @internal
 */
function checkEntry(name: string, value: unknown, dataLength: number): HeaderEntry {
  if (!value || typeof value !== 'object') {
    throw new Error(`header entry '${name}' is not an object`);
  }
  const entry = value as Partial<HeaderEntry>;
  const dtype = DTYPE_NAMES[entry.dtype as string];
  if (!dtype) {
    throw new Error(
      `tensor '${name}' has dtype ${String(entry.dtype)}, which this engine cannot represent`,
    );
  }
  if (!Array.isArray(entry.shape) || entry.shape.some((d) => !Number.isInteger(d) || d < 0)) {
    throw new Error(`tensor '${name}' has a malformed shape`);
  }
  const offsets = entry.data_offsets;
  if (!Array.isArray(offsets) || offsets.length !== 2) {
    throw new Error(`tensor '${name}' has malformed data offsets`);
  }
  const [start, end] = offsets;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new Error(`tensor '${name}' has data offsets [${start}, ${end}]`);
  }
  if (end > dataLength) {
    throw new Error(
      `tensor '${name}' claims bytes up to ${end} but the data section holds ${dataLength}`,
    );
  }
  const expected = numel(entry.shape) * DTYPE_BYTES[dtype];
  if (end - start !== expected) {
    throw new Error(
      `tensor '${name}' spans ${end - start} bytes but shape [${entry.shape.join(', ')}] of ${dtype} needs ${expected}`,
    );
  }
  return { dtype: entry.dtype as string, shape: entry.shape, data_offsets: [start, end] };
}

/**
 * Load tensors from a safetensors file.
 *
 * Every tensor by default; `names` narrows that, which is what makes loading one
 * shard of a sharded checkpoint or a single layer's weights cheap.
 *
 * The result is keyed the way the file is, so it can be handed to
 * `Module.loadStateDict` when the names line up.
 */
export async function loadSafetensors(
  path: string,
  options: LoadOptions = {},
): Promise<Map<string, Tensor>> {
  const file = await openSafetensors(path);
  try {
    const device = await resolveDevice(options.device ?? 'auto');
    const wanted = options.names ?? file.list().map((info) => info.name);
    const out = new Map<string, Tensor>();
    try {
      for (const name of wanted) out.set(name, await file.read(name, device));
    } catch (cause) {
      // A partial load leaks device memory the caller has no handle to.
      for (const tensor of out.values()) tensor.dispose();
      throw cause;
    }
    return out;
  } finally {
    await file.close();
  }
}

/**
 * Write tensors to a safetensors file.
 *
 * Reads every tensor back to the host first, since the format stores host bytes and
 * the values may be on a device. Names are sorted, so saving the same model twice
 * produces the same file.
 */
export async function saveSafetensors(
  path: string,
  tensors: ReadonlyMap<string, Tensor>,
  metadata: Readonly<Record<string, string>> = {},
): Promise<void> {
  const names = [...tensors.keys()].sort();
  const payloads: Uint8Array[] = [];
  const header: Record<string, unknown> = {};
  if (Object.keys(metadata).length > 0) header.__metadata__ = metadata;

  let offset = 0;
  for (const name of names) {
    const tensor = tensors.get(name)!;
    const encoded = NAMES_BY_DTYPE[tensor.dtype];
    if (!encoded) {
      throw new Error(
        `cannot write tensor '${name}': dtype ${tensor.dtype} has no safetensors name`,
      );
    }
    const bytes = await readBytes(tensor);
    header[name] = {
      dtype: encoded,
      shape: [...tensor.shape],
      data_offsets: [offset, offset + bytes.length],
    };
    payloads.push(bytes);
    offset += bytes.length;
  }

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const fs = new DiskFileSystem();
  const file = await fs.open(path, 'w');
  try {
    const prefix = new Uint8Array(8);
    new DataView(prefix.buffer).setBigUint64(0, BigInt(headerBytes.length), true);
    let position = 0;
    for (const chunk of [prefix, headerBytes, ...payloads]) {
      if (chunk.length === 0) continue;
      await file.pwrite(position, chunk);
      position += chunk.length;
    }
  } finally {
    await file.close();
  }
}
