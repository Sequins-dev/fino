/**
 * CUDA driver for the tensor engine.
 *
 * Uses the NVIDIA Driver API for memory, streams, modules, and launches, and NVRTC
 * for runtime compilation. Both libraries are loaded lazily; importing the tensor
 * module remains safe on machines without NVIDIA software.
 *
 * Useful references:
 *
 * - <https://docs.nvidia.com/cuda/cuda-driver-api/>
 * - <https://docs.nvidia.com/cuda/nvrtc/>
 *
 * @internal
 */
import { env } from 'internal:process';
import { dlopen, Pointer } from 'fino:ffi';
import type { KernelIR } from '../ir/index.ts';
import { lowerToCUDA } from '../ir/index.ts';
import type { DriverBuffer, DriverCaps, DriverKernel, GpuDriver } from './driver.ts';

const DRIVER_SYMBOLS = {
  cuInit: { parameters: ['u32'], result: 'i32' },
  cuDeviceGetCount: { parameters: ['buffer'], result: 'i32' },
  cuDeviceGet: { parameters: ['buffer', 'i32'], result: 'i32' },
  cuDeviceGetName: { parameters: ['buffer', 'i32', 'i32'], result: 'i32' },
  cuDeviceGetAttribute: { parameters: ['buffer', 'i32', 'i32'], result: 'i32' },
  cuCtxCreate_v2: { parameters: ['buffer', 'u32', 'i32'], result: 'i32' },
  cuCtxDestroy_v2: { parameters: ['pointer'], result: 'i32' },
  cuStreamCreate: { parameters: ['buffer', 'u32'], result: 'i32' },
  cuStreamDestroy_v2: { parameters: ['pointer'], result: 'i32' },
  cuStreamSynchronize: { parameters: ['pointer'], result: 'i32', async: true },
  cuStreamQuery: { parameters: ['pointer'], result: 'i32' },
  cuMemAlloc_v2: { parameters: ['buffer', 'usize'], result: 'i32' },
  cuMemFree_v2: { parameters: ['u64'], result: 'i32' },
  cuMemcpyHtoDAsync_v2: { parameters: ['u64', 'buffer', 'usize', 'pointer'], result: 'i32' },
  cuMemcpyDtoHAsync_v2: { parameters: ['buffer', 'u64', 'usize', 'pointer'], result: 'i32' },
  cuMemcpyDtoDAsync_v2: { parameters: ['u64', 'u64', 'usize', 'pointer'], result: 'i32' },
  cuModuleLoadData: { parameters: ['buffer', 'buffer'], result: 'i32' },
  cuModuleUnload: { parameters: ['pointer'], result: 'i32' },
  cuModuleGetFunction: { parameters: ['buffer', 'pointer', 'buffer'], result: 'i32' },
  cuLaunchKernel: {
    parameters: [
      'pointer',
      'u32',
      'u32',
      'u32',
      'u32',
      'u32',
      'u32',
      'u32',
      'pointer',
      'buffer',
      'pointer',
    ],
    result: 'i32',
  },
} as const;

const NVRTC_SYMBOLS = {
  nvrtcCreateProgram: {
    parameters: ['buffer', 'buffer', 'buffer', 'i32', 'pointer', 'pointer'],
    result: 'i32',
  },
  nvrtcDestroyProgram: { parameters: ['buffer'], result: 'i32' },
  nvrtcCompileProgram: { parameters: ['pointer', 'i32', 'buffer'], result: 'i32' },
  nvrtcGetPTXSize: { parameters: ['pointer', 'buffer'], result: 'i32' },
  nvrtcGetPTX: { parameters: ['pointer', 'buffer'], result: 'i32' },
  nvrtcGetProgramLogSize: { parameters: ['pointer', 'buffer'], result: 'i32' },
  nvrtcGetProgramLog: { parameters: ['pointer', 'buffer'], result: 'i32' },
  nvrtcGetErrorString: { parameters: ['i32'], result: 'pointer' },
} as const;

type DriverLib = ReturnType<typeof openDriver>;
type NvrtcLib = ReturnType<typeof openNvrtc>;

const text = new TextEncoder();
const cstring = (value: string): Uint8Array => text.encode(`${value}\0`);
const i32slot = (): Int32Array => new Int32Array(1);
const ptrslot = (): ArrayBuffer => new ArrayBuffer(8);
const ptrValue = (slot: ArrayBuffer): ArrayBuffer | null => {
  const value = new DataView(slot).getBigUint64(0, true);
  return value === 0n ? null : slot;
};
const devicePtr = (buffer: CudaBuffer): bigint => new DataView(buffer.handle).getBigUint64(0, true);

function openDriver() {
  return dlopen(env.FINO_CUDA_LIBRARY ?? 'libcuda.so.1', DRIVER_SYMBOLS as never);
}

function openNvrtc() {
  const candidates = [
    env.FINO_CUDA_NVRTC_LIBRARY,
    'libnvrtc.so.12',
    'libnvrtc.so',
    '/usr/local/cuda/lib64/libnvrtc.so.12',
    '/usr/local/cuda/lib64/libnvrtc.so',
    `${env.HOME ?? ''}/.local/lib/python3.13/site-packages/nvidia/cuda_nvrtc/lib/libnvrtc.so.12`,
    `${env.HOME ?? ''}/.local/lib/python3.14/site-packages/nvidia/cuda_nvrtc/lib/libnvrtc.so.12`,
    `${env.HOME ?? ''}/.local/lib/python3.12/site-packages/nvidia/cuda_nvrtc/lib/libnvrtc.so.12`,
    `${env.HOME ?? ''}/.local/lib/python3.11/site-packages/nvidia/cuda_nvrtc/lib/libnvrtc.so.12`,
  ].filter((p): p is string => Boolean(p));
  const failures: string[] = [];
  for (const path of candidates) {
    try {
      return dlopen(path, NVRTC_SYMBOLS as never);
    } catch (cause) {
      failures.push(`${path}: ${(cause as Error).message}`);
    }
  }
  throw new Error(`no NVRTC library found. Tried:\n  ${failures.join('\n  ')}`);
}

let availability: { driver: DriverLib; nvrtc: NvrtcLib } | { error: string } | null = null;
function libraries(): { driver: DriverLib; nvrtc: NvrtcLib } {
  if (!availability) {
    try {
      const driver = openDriver();
      check(driver, 'cuInit', driver.symbols.cuInit(0) as number);
      availability = { driver, nvrtc: openNvrtc() };
    } catch (cause) {
      availability = { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  if ('error' in availability) throw new Error(availability.error);
  return availability;
}

/** Whether both the CUDA driver and runtime compiler are usable. */
export function cudaDriverAvailable(): boolean {
  try {
    const { driver } = libraries();
    const count = i32slot();
    check(driver, 'cuDeviceGetCount', driver.symbols.cuDeviceGetCount(count) as number);
    return count[0]! > 0;
  } catch {
    return false;
  }
}

/** Why CUDA is unavailable, or `null` when a device can be created. */
export function cudaDriverReason(): string | null {
  if (cudaDriverAvailable()) return null;
  return availability && 'error' in availability ? availability.error : 'no CUDA device';
}

function errorName(result: number): string {
  return result === 0
    ? 'CUDA_SUCCESS'
    : result === 100
      ? 'CUDA_ERROR_NO_DEVICE'
      : result === 2
        ? 'CUDA_ERROR_OUT_OF_MEMORY'
        : `CUDA error ${result}`;
}

function check(_lib: DriverLib, call: string, result: number): void {
  if (result !== 0) throw new Error(`${call} failed: ${errorName(result)}`);
}

interface CudaBuffer extends DriverBuffer {
  handle: ArrayBuffer;
}
interface CudaKernel extends DriverKernel {
  module: ArrayBuffer;
  function: ArrayBuffer;
  params: KernelIR['params'];
}

/** Create a CUDA driver for device `index`. */
export function createCudaDriver(index = 0): GpuDriver {
  const { driver, nvrtc } = libraries();
  const dev = i32slot();
  check(driver, 'cuDeviceGet', driver.symbols.cuDeviceGet(dev, index) as number);
  const nameBytes = new Uint8Array(256);
  check(
    driver,
    'cuDeviceGetName',
    driver.symbols.cuDeviceGetName(nameBytes, nameBytes.length, dev[0]) as number,
  );
  const zero = nameBytes.indexOf(0);
  const name = new TextDecoder().decode(nameBytes.subarray(0, zero < 0 ? nameBytes.length : zero));
  const attribute = (id: number): number => {
    const out = i32slot();
    check(
      driver,
      'cuDeviceGetAttribute',
      driver.symbols.cuDeviceGetAttribute(out, id, dev[0]) as number,
    );
    return out[0]!;
  };
  const major = attribute(75),
    minor = attribute(76);
  const contextSlot = ptrslot();
  check(driver, 'cuCtxCreate_v2', driver.symbols.cuCtxCreate_v2(contextSlot, 0, dev[0]) as number);
  const context = ptrValue(contextSlot)!;
  const streamSlot = ptrslot();
  check(driver, 'cuStreamCreate', driver.symbols.cuStreamCreate(streamSlot, 1) as number);
  const stream = ptrValue(streamSlot)!;
  const caps: DriverCaps = {
    type: 'cuda',
    name,
    f16: major >= 6,
    atomicFloat: major >= 2,
    subgroups: true,
    matrix: false,
    maxWorkgroup: attribute(1),
  };
  let next = 0n,
    done = 0n;
  const uploads: Uint8Array[] = [];
  const coherent = new Set<CudaBuffer>();

  async function synchronize(token: bigint): Promise<void> {
    if (token <= done) return;
    for (const buffer of coherent) {
      check(
        driver,
        'cuMemcpyDtoHAsync_v2',
        driver.symbols.cuMemcpyDtoHAsync_v2(
          new Uint8Array(buffer.host!),
          devicePtr(buffer),
          buffer.byteLength,
          stream,
        ) as number,
      );
    }
    check(
      driver,
      'cuStreamSynchronize',
      (await driver.symbols.cuStreamSynchronize(stream)) as number,
    );
    done = next;
    uploads.length = 0;
    coherent.clear();
  }

  return {
    caps,
    target: `cuda-compute_${major}${minor}:${name}`,
    hostVisible: false,
    alloc(bytes: number): DriverBuffer {
      const handle = ptrslot();
      check(
        driver,
        'cuMemAlloc_v2',
        driver.symbols.cuMemAlloc_v2(handle, Math.max(bytes, 1)) as number,
      );
      return { handle, byteLength: Math.max(bytes, 1), host: null } as CudaBuffer;
    },
    allocHost(bytes: number): DriverBuffer {
      const buffer = this.alloc(bytes) as CudaBuffer;
      return { ...buffer, host: new ArrayBuffer(buffer.byteLength) };
    },
    free(buffer: DriverBuffer): void {
      check(
        driver,
        'cuMemFree_v2',
        driver.symbols.cuMemFree_v2(devicePtr(buffer as CudaBuffer)) as number,
      );
    },
    write(buffer: DriverBuffer, offset: number, bytes: Uint8Array): void {
      const copy = bytes.slice();
      uploads.push(copy);
      check(
        driver,
        'cuMemcpyHtoDAsync_v2',
        driver.symbols.cuMemcpyHtoDAsync_v2(
          devicePtr(buffer as CudaBuffer) + BigInt(offset),
          copy,
          copy.byteLength,
          stream,
        ) as number,
      );
      next++;
    },
    async read(buffer: DriverBuffer, offset: number, length: number): Promise<Uint8Array> {
      const out = new Uint8Array(length);
      check(
        driver,
        'cuMemcpyDtoHAsync_v2',
        driver.symbols.cuMemcpyDtoHAsync_v2(
          out,
          devicePtr(buffer as CudaBuffer) + BigInt(offset),
          length,
          stream,
        ) as number,
      );
      next++;
      await synchronize(next);
      return out;
    },
    copy(dst, dstOffset, src, srcOffset, bytes): void {
      check(
        driver,
        'cuMemcpyDtoDAsync_v2',
        driver.symbols.cuMemcpyDtoDAsync_v2(
          devicePtr(dst as CudaBuffer) + BigInt(dstOffset),
          devicePtr(src as CudaBuffer) + BigInt(srcOffset),
          bytes,
          stream,
        ) as number,
      );
      next++;
    },
    async compile(ir: KernelIR): Promise<DriverKernel> {
      const source = lowerToCUDA(ir, { architecture: `compute_${major}${minor}` });
      const programSlot = ptrslot();
      let result = nvrtc.symbols.nvrtcCreateProgram(
        programSlot,
        cstring(source),
        cstring(`${ir.name}.cu`),
        0,
        null,
        null,
      ) as number;
      if (result !== 0) throw new Error(`nvrtcCreateProgram failed with ${result}`);
      const program = ptrValue(programSlot)!;
      const options = [
        cstring(`--gpu-architecture=compute_${major}${minor}`),
        cstring('--std=c++17'),
        cstring('--fmad=false'),
      ];
      const includePaths = [
        env.FINO_CUDA_INCLUDE,
        '/usr/local/cuda/include',
        `${env.HOME ?? ''}/.local/lib/python3.14/site-packages/nvidia/cuda_runtime/include`,
        `${env.HOME ?? ''}/.local/lib/python3.13/site-packages/nvidia/cuda_runtime/include`,
        `${env.HOME ?? ''}/.local/lib/python3.12/site-packages/nvidia/cuda_runtime/include`,
        `${env.HOME ?? ''}/.local/lib/python3.11/site-packages/nvidia/cuda_runtime/include`,
      ].filter((path): path is string => Boolean(path));
      for (const path of includePaths) options.push(cstring(`--include-path=${path}`));
      const optionPtrs = new BigUint64Array(options.map((o) => Pointer.addr(o)));
      result = nvrtc.symbols.nvrtcCompileProgram(program, options.length, optionPtrs) as number;
      if (result !== 0) {
        const size = new BigUint64Array(1);
        nvrtc.symbols.nvrtcGetProgramLogSize(program, size);
        const log = new Uint8Array(Number(size[0]));
        nvrtc.symbols.nvrtcGetProgramLog(program, log);
        nvrtc.symbols.nvrtcDestroyProgram(programSlot);
        throw new Error(
          `NVRTC failed for ${ir.name}: ${new TextDecoder().decode(log).replace(/\0$/, '')}`,
        );
      }
      const size = new BigUint64Array(1);
      nvrtc.symbols.nvrtcGetPTXSize(program, size);
      const ptx = new Uint8Array(Number(size[0]));
      nvrtc.symbols.nvrtcGetPTX(program, ptx);
      nvrtc.symbols.nvrtcDestroyProgram(programSlot);
      const moduleSlot = ptrslot();
      check(driver, 'cuModuleLoadData', driver.symbols.cuModuleLoadData(moduleSlot, ptx) as number);
      const module = ptrValue(moduleSlot)!;
      const functionSlot = ptrslot();
      check(
        driver,
        'cuModuleGetFunction',
        driver.symbols.cuModuleGetFunction(functionSlot, module, cstring(ir.name)) as number,
      );
      return {
        entry: ir.name,
        workgroup: ir.wg,
        module,
        function: ptrValue(functionSlot)!,
        params: ir.params,
      } as CudaKernel;
    },
    release(kernel): void {
      check(
        driver,
        'cuModuleUnload',
        driver.symbols.cuModuleUnload((kernel as CudaKernel).module) as number,
      );
    },
    launch(kernel, buffers, params, groups): bigint {
      const k = kernel as CudaKernel;
      for (const raw of buffers) {
        const buffer = raw as CudaBuffer;
        if (!buffer.host) continue;
        check(
          driver,
          'cuMemcpyHtoDAsync_v2',
          driver.symbols.cuMemcpyHtoDAsync_v2(
            devicePtr(buffer),
            new Uint8Array(buffer.host),
            buffer.byteLength,
            stream,
          ) as number,
        );
        coherent.add(buffer);
      }
      const args: (ArrayBuffer | ArrayBufferView)[] = buffers.map((b) => (b as CudaBuffer).handle);
      for (let i = 0; i < k.params.length; i++) args.push(new Uint8Array(params, i * 4, 4));
      const pointers = new BigUint64Array(args.map((arg) => Pointer.addr(arg)));
      check(
        driver,
        'cuLaunchKernel',
        driver.symbols.cuLaunchKernel(
          k.function,
          groups[0],
          groups[1],
          groups[2],
          k.workgroup[0],
          k.workgroup[1],
          k.workgroup[2],
          0,
          stream,
          pointers,
          null,
        ) as number,
      );
      return ++next;
    },
    async wait(token): Promise<void> {
      await synchronize(token);
    },
    submitted(): bigint {
      return next;
    },
    canLaunch(): boolean {
      return true;
    },
    completed(): bigint {
      if (coherent.size > 0) return done;
      if (done < next && (driver.symbols.cuStreamQuery(stream) as number) === 0) {
        done = next;
        uploads.length = 0;
      }
      return done;
    },
    dispose(): void {
      void synchronize(next).then(() => {
        driver.symbols.cuStreamDestroy_v2(stream);
        driver.symbols.cuCtxDestroy_v2(context);
      });
    },
  };
}
