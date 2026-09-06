/**
 * Can a CoreML model be compiled, loaded, and run entirely through FFI? (FIN-156)
 *
 * A graph-class backend is a different shape from every device this engine has: you
 * cannot hand it a kernel, you hand it a whole subgraph and its compiler schedules it.
 * CoreML is the natural first one because the hardware is already here, but the plan
 * rested on a claim — that `MLModel` and friends are reachable through the same
 * `objc_msgSend` bindings built for Metal, with no custom native code. This checks the
 * claim before anything is built on it.
 *
 * The answer is yes. Every class resolves, `compileModelAtURL:error:` produces an
 * `.mlmodelc`, the model loads under a `cpuAndNeuralEngine` configuration, and a
 * prediction comes back matching a host computation of the same product.
 *
 * ## What this does not yet show
 *
 * Where the work ran. CoreML treats `cpuAndNeuralEngine` as a request rather than an
 * instruction, and `MLComputePlan` — which reports per-operation placement — is
 * block-based, a mechanism this codebase has never needed. Confirming Neural Engine
 * placement is the remaining half of the feasibility question and is deliberately not
 * assumed here.
 *
 * Skipped when the fixture is absent; `tests/fixtures/coreml/generate.py` makes it.
 */
import { describe, it } from 'fino:test/test';
import { dlopen, Pointer } from 'fino:ffi';
import {
  errorSlot,
  nsArray,
  nsDictionary,
  nsNumber,
  nsString,
  objcAvailable,
  objcClass,
  readNSString,
  sel,
  send,
  takeError,
  withPool,
} from 'internal:metal';
import { DiskFileSystem } from 'fino:file';

/** `MLMultiArrayDataType.float32`. */
const FLOAT32 = 65568n;

/**
 * `MLComputeUnitsCPUAndNeuralEngine`.
 *
 * Three, not two. The enum runs cpuOnly, cpuAndGPU, all, cpuAndNeuralEngine, so the
 * obvious guess selects the GPU — which this spike did until the header was read, under
 * a constant named for what it was not doing. That is precisely the reason the placement
 * question below is not settled by the configuration having been accepted.
 */
const CPU_AND_NEURAL_ENGINE = 3n;

const SIDE = 256;
const FIXTURE = 'tests/fixtures/coreml/matmul.mlpackage';

/** Whether the generated model is present. */
async function fixtureExists(): Promise<boolean> {
  try {
    await new DiskFileSystem('.').stat(FIXTURE);
    return true;
  } catch {
    return false;
  }
}

describe('CoreML through FFI', () => {
  it('resolves the classes it needs', (t) => {
    if (!objcAvailable()) {
      t.ok(true, 'SKIP: no Objective-C runtime');
      return;
    }
    // The framework has to be loaded before any of its classes exist; nothing else in
    // the process has a reason to have pulled it in.
    dlopen('/System/Library/Frameworks/CoreML.framework/CoreML', {});
    for (const name of [
      'MLModel',
      'MLMultiArray',
      'MLModelConfiguration',
      'MLDictionaryFeatureProvider',
    ]) {
      t.ok(objcClass(name) !== null, `${name} resolves`);
    }
  });

  it('compiles, loads, and predicts', async (t) => {
    if (!objcAvailable() || !(await fixtureExists())) {
      t.ok(true, 'SKIP: no Objective-C runtime, or the fixture has not been generated');
      return;
    }
    dlopen('/System/Library/Frameworks/CoreML.framework/CoreML', {});

    let first = Number.NaN;
    let outputName = '';
    withPool(() => {
      const MLModel = objcClass('MLModel')!;
      const slot = errorSlot();

      const source = send.ptrPtr(objcClass('NSURL')!, sel('fileURLWithPath:'), nsString(FIXTURE));
      const compiled = send.ptrPtrBuf(MLModel, sel('compileModelAtURL:error:'), source, slot);
      if (!compiled) throw new Error(`compile failed: ${takeError(slot) ?? 'no error given'}`);

      const config = send.ptr(
        send.ptr(objcClass('MLModelConfiguration')!, sel('alloc')),
        sel('init'),
      );
      send.voidI64(config, sel('setComputeUnits:'), CPU_AND_NEURAL_ENGINE);
      const model = send.ptrPtrPtrBuf(
        MLModel,
        sel('modelWithContentsOfURL:configuration:error:'),
        compiled,
        config,
        slot,
      );
      if (!model) throw new Error(`load failed: ${takeError(slot) ?? 'no error given'}`);

      const multiArray = (dims: readonly number[]) => {
        const array = send.ptrPtrI64Buf(
          send.ptr(objcClass('MLMultiArray')!, sel('alloc')),
          sel('initWithShape:dataType:error:'),
          nsArray(dims.map(nsNumber)),
          FLOAT32,
          slot,
        );
        if (!array) throw new Error(`MLMultiArray failed: ${takeError(slot) ?? 'no error'}`);
        return array;
      };
      const write = (array: unknown, count: number, value: (i: number) => number) => {
        const view = new Float32Array(
          Pointer.view(send.ptr(array as never, sel('dataPointer')) as never, count * 4),
        );
        for (let i = 0; i < count; i++) view[i] = value(i);
      };

      const x = multiArray([1, SIDE]);
      const w = multiArray([SIDE, SIDE]);
      write(x, SIDE, (i) => (i % 7) / 7);
      write(w, SIDE * SIDE, (i) => (i % 5) / 5);

      const features = send.ptrPtrBuf(
        send.ptr(objcClass('MLDictionaryFeatureProvider')!, sel('alloc')),
        sel('initWithDictionary:error:'),
        nsDictionary([nsString('x'), nsString('w')], [x, w]),
        slot,
      );
      if (!features) throw new Error(`features failed: ${takeError(slot) ?? 'no error'}`);

      const prediction = send.ptrPtrBuf(
        model,
        sel('predictionFromFeatures:error:'),
        features,
        slot,
      );
      if (!prediction) throw new Error(`predict failed: ${takeError(slot) ?? 'no error'}`);

      outputName = readNSString(
        send.ptr(
          send.ptr(send.ptr(prediction, sel('featureNames')), sel('allObjects')),
          sel('firstObject'),
        ),
      );
      const value = send.ptrPtr(prediction, sel('featureValueForName:'), nsString(outputName));
      const result = send.ptr(value, sel('multiArrayValue'));
      first = new Float32Array(
        Pointer.view(send.ptr(result, sel('dataPointer')) as never, SIDE * 4),
      )[0]!;
    });

    t.ok(outputName.length > 0, `the prediction names its output ('${outputName}')`);
    // The same dot product on the host. The model runs in float16, so this is a
    // tolerance rather than an equality.
    let want = 0;
    for (let k = 0; k < SIDE; k++) want += ((k % 7) / 7) * (((k * SIDE) % 5) / 5);
    t.ok(
      Math.abs(first - want) < Math.abs(want) * 1e-2,
      `and computes the right product (${first.toFixed(4)} against ${want.toFixed(4)})`,
    );
  });
});
