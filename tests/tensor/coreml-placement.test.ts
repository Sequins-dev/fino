/**
 * Where CoreML decides to run each operation (FIN-156).
 *
 * `cpuAndNeuralEngine` is a request, not an instruction — CoreML chooses placement, and
 * a configuration being accepted says nothing about what it selected. `MLComputePlan`
 * reports the decision per operation, which turns "did the Neural Engine run this" from
 * an assumption into an assertion. That question is the gate on whether a graph-class
 * backend is worth building, so it has to be answerable from here.
 *
 * It is answerable. Reading it needs an Objective-C block, since the API is
 * block-based, and one can be assembled by hand — see {@link blockLiteral}.
 *
 * ## What it reports on this machine
 *
 * Size decides it. The single-operation fixtures — a matrix multiply, a convolution —
 * run entirely on the CPU, and it is tempting to read that as the Neural Engine being
 * unreachable. It is not: eight matrix multiplies at the size a real layer uses go
 * entirely to the Neural Engine, activations included.
 *
 * That both answers are readable here is the point. `coremltools` reports exactly the
 * same placement for the same compiled models from Python, which is the control that
 * makes the negative result trustworthy rather than indistinguishable from a broken
 * binding.
 *
 * The operations that landed there are the ones this engine emits — `matmul` and an
 * activation — which is what the graph-backend plan needed to know. So does the same
 * stack with every weight arriving as an input rather than baked in at conversion time,
 * which is the shape a recorded graph actually hands over and decides whether a
 * compiled region survives a weight update or has to be rebuilt each step.
 *
 * float16 typing was the other suspect, since the documentation says float32-typed
 * programs are barred from the Neural Engine. Converting the convolution with float16
 * input and output types changed nothing on its own, so it is not sufficient by itself;
 * the stack fixture uses it anyway, being both realistic and what the documentation
 * asks for.
 *
 * Skipped when the fixtures are absent; `tests/fixtures/coreml/generate.py` makes them.
 */
import { describe, it } from 'fino:test/test';
import { dlopen } from 'fino:ffi';
import {
  blockLiteral,
  errorSlot,
  nsString,
  objcAvailable,
  objcClass,
  readNSString,
  retain,
  sel,
  send,
  takeError,
  withPool,
} from 'internal:metal';
import { DiskFileSystem } from 'fino:file';
import { FfiCallback } from 'fino:ffi';

/** `MLComputeUnitsCPUAndNeuralEngine`. */
const CPU_AND_NEURAL_ENGINE = 3n;

/** The pointer an Objective-C handle holds, as distinct from the handle's address. */
function handleValue(object: unknown): bigint {
  return new DataView(object as ArrayBuffer).getBigUint64(0, true);
}

/** Whether a fixture is present. */
async function exists(path: string): Promise<boolean> {
  try {
    await new DiskFileSystem('.').stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Operation name to the class of the device CoreML prefers for it. */
async function placement(fixture: string): Promise<Map<string, string>> {
  dlopen('/System/Library/Frameworks/CoreML.framework/CoreML', {});
  const found = new Map<string, string>();
  let plan: unknown = null;
  let settled = false;

  const callback = new FfiCallback(
    { parameters: ['pointer', 'pointer', 'pointer'], result: 'void' },
    (_block: unknown, loaded: unknown) => {
      // Retained here rather than later: the plan arrives autoreleased and is gone once
      // this call returns, which is also why this handler is not deferred.
      if (loaded && handleValue(loaded) !== 0n) plan = retain(loaded as never);
      settled = true;
    },
  );
  const block = blockLiteral(callback);

  withPool(() => {
    const slot = errorSlot();
    const source = send.ptrPtr(objcClass('NSURL')!, sel('fileURLWithPath:'), nsString(fixture));
    const compiled = send.ptrPtrBuf(objcClass('MLModel')!, sel('compileModelAtURL:error:'), source, slot);
    if (!compiled) throw new Error(`compile failed: ${takeError(slot) ?? 'no error'}`);
    const config = send.ptr(send.ptr(objcClass('MLModelConfiguration')!, sel('alloc')), sel('init'));
    send.voidI64(config, sel('setComputeUnits:'), CPU_AND_NEURAL_ENGINE);
    send.voidPtrPtrPtr(
      objcClass('MLComputePlan')!,
      sel('loadContentsOfURL:configuration:completionHandler:'),
      compiled,
      config,
      block.pointer,
    );
  });

  for (let i = 0; i < 300 && !settled; i++) await new Promise((r) => setTimeout(r, 20));
  if (!plan) throw new Error('the compute plan never arrived');

  withPool(() => {
    const program = send.ptr(send.ptr(plan as never, sel('modelStructure')), sel('program'));
    const main = send.ptrPtr(send.ptr(program, sel('functions')), sel('objectForKey:'), nsString('main'));
    const operations = send.ptr(send.ptr(main, sel('block')), sel('operations'));
    const count = Number(send.u64(operations, sel('count')));
    for (let i = 0; i < count; i++) {
      const operation = send.ptrU64(operations, sel('objectAtIndex:'), BigInt(i));
      const usage = send.ptrPtr(
        plan as never,
        sel('computeDeviceUsageForMLProgramOperation:'),
        operation,
      );
      if (!usage || handleValue(usage) === 0n) continue;
      const device = send.ptr(usage, sel('preferredComputeDevice'));
      found.set(
        readNSString(send.ptr(operation, sel('operatorName'))),
        readNSString(send.ptr(send.ptr(device, sel('class')), sel('description'))),
      );
    }
  });
  void block.retained;
  return found;
}

describe('CoreML operation placement', () => {
  it('reads per-operation device assignment for a matrix multiply', async (t) => {
    if (!objcAvailable() || !(await exists('tests/fixtures/coreml/matmul.mlpackage'))) {
      t.ok(true, 'SKIP: no Objective-C runtime, or the fixtures are not generated');
      return;
    }
    const found = await placement('tests/fixtures/coreml/matmul.mlpackage');
    t.ok(found.size > 0, `placement is readable (${found.size} operations)`);
    t.ok(found.has('ios16.matmul'), 'the multiply is among them');
    // Asserted as "a device was chosen" rather than which one: the choice is CoreML's
    // and depends on the model and the machine, so pinning it here would be pinning
    // someone else's decision.
    for (const [operation, device] of found) {
      t.ok(device.endsWith('ComputeDevice'), `${operation} is assigned to ${device}`);
    }
  });

  it('reads it for a convolution too', async (t) => {
    if (!objcAvailable() || !(await exists('tests/fixtures/coreml/conv.mlpackage'))) {
      t.ok(true, 'SKIP: no Objective-C runtime, or the fixtures are not generated');
      return;
    }
    const found = await placement('tests/fixtures/coreml/conv.mlpackage');
    t.ok(found.has('ios16.conv'), 'the convolution is reported');
  });

  it('puts a realistically sized stack on the Neural Engine', async (t) => {
    if (!objcAvailable() || !(await exists('tests/fixtures/coreml/stack.mlpackage'))) {
      t.ok(true, 'SKIP: no Objective-C runtime, or the fixtures are not generated');
      return;
    }
    // The case the whole exercise was for. Eight matrix multiplies of a size a real
    // layer uses, in the shape this engine emits, float16 in and out. The single tiny
    // operations above stay on the CPU; this does not, and the difference is size.
    const found = await placement('tests/fixtures/coreml/stack.mlpackage');
    const devices = new Set(found.values());
    t.ok(found.size > 0, `placement is readable (${found.size} operations)`);
    t.ok(
      devices.has('MLNeuralEngineComputeDevice'),
      `the Neural Engine is chosen (${[...devices].join(', ')})`,
    );
    const matmuls = [...found].filter(([name]) => name.includes('matmul'));
    t.ok(matmuls.length > 0, `matrix multiplies are present (${matmuls.length})`);
    t.ok(
      matmuls.every(([, device]) => device === 'MLNeuralEngineComputeDevice'),
      'and every one of them runs there',
    );
  });

  it('does so with weights arriving as inputs rather than constants', async (t) => {
    if (!objcAvailable() || !(await exists('tests/fixtures/coreml/runtime-weights.mlpackage'))) {
      t.ok(true, 'SKIP: no Objective-C runtime, or the fixtures are not generated');
      return;
    }
    // What decides whether a compiled region survives a weight update. Baked-in weights
    // would mean rebuilding the region every step, which at hundreds of milliseconds a
    // compile would cost more than it saves. Weights as inputs do not.
    const found = await placement('tests/fixtures/coreml/runtime-weights.mlpackage');
    const matmuls = [...found].filter(([name]) => name.includes('matmul'));
    t.ok(matmuls.length > 0, `matrix multiplies are present (${matmuls.length})`);
    t.ok(
      matmuls.every(([, device]) => device === 'MLNeuralEngineComputeDevice'),
      'every one runs on the Neural Engine with runtime operands',
    );
  });
});
