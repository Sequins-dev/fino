/**
 * `fino:tensor/io` — reading and writing tensors as files.
 *
 * ```ts no_run
 * import { loadSafetensors } from 'fino:tensor/io';
 * import { device } from 'fino:tensor';
 *
 * const weights = await loadSafetensors('model.safetensors', { device: await device('auto') });
 * model.loadStateDict(weights);
 * ```
 *
 * Both supported formats store row-major, contiguous, little-endian bytes — the
 * layout a device already wants — so a tensor goes from the file to device memory
 * without a conversion pass. That is the reason these two and not others: loading is
 * bounded by I/O rather than by decoding.
 *
 * `openSafetensors` is the lower-level door. It parses the header and then reads
 * tensors individually, so inspecting a checkpoint, loading one shard, or loading a
 * single layer costs only what it touches rather than the whole file.
 *
 * The loaders produce tensors, not modules: shapes and names come from the file and a
 * model has to agree with them. Pass the result to `Module.loadStateDict`, which
 * checks that agreement rather than assuming it.
 *
 * ## Not supported
 *
 * GGUF, whose value is its quantised block formats — loading one means dequantising
 * it, which needs kernels this engine does not yet have. Reading a GGUF file's
 * `f16`/`f32` tensors alone would load some models and silently fail on the ones
 * people actually use it for, so it is absent rather than half-present.
 *
 * PyTorch `.pt`/`.pth` files are pickled Python object graphs. Unpickling executes
 * arbitrary constructors by design, so it is not something to implement for untrusted
 * files; convert to safetensors instead.
 *
 * ## Status
 *
 * Experimental, alongside the rest of `fino:tensor`.
 */
export { loadNpy, saveNpy } from './npy.ts';
export {
  SafetensorsFile,
  loadSafetensors,
  openSafetensors,
  saveSafetensors,
} from './safetensors.ts';
export type { LoadOptions, TensorInfo } from './safetensors.ts';
