/** Compilation ownership and native compiler diagnostics. */
import { describe, it } from 'fino:test/test';
import { openDevice } from 'internal:metal';
import { lowerToMSL } from 'internal:kernel/msl';
import { fixtures } from '../kernel/fixtures.ts';
import { env } from 'fino:process';
describe('Metal pipeline ownership', () => {
  it('validates inputs and owns a successful pipeline independently of its device', async (t) => {
    let compiled = 0;
    let released = 0;
    const api = {
      createDevice: () => new ArrayBuffer(8),
      info: () => ({ name: 'fake', unifiedMemory: true, maxBufferLength: 1024 }),
      createBuffer: () => null,
      contents: () => null,
      retain: (value: ArrayBuffer) => value,
      release: () => {},
      compile: async (_device: ArrayBuffer, source: string, entry: string) => {
        compiled++;
        t.equal(source, 'source');
        t.equal(entry, 'kernel_main');
        return {
          pointer: new ArrayBuffer(8),
          threadExecutionWidth: 32,
          maxThreadsPerThreadgroup: 256,
          close: () => released++,
        };
      },
    };
    const device = openDevice(api)!;
    await t.rejects(() => device.compile('source', ''), /entry/);
    await t.rejects(() => device.compile('source', 'bad\0entry'), /entry/);
    await t.rejects(() => device.compile(null as any, 'kernel_main'), /source/);
    t.equal(compiled, 0);
    using pipeline = await device.compile('source', 'kernel_main');
    device.close();
    t.equal(released, 0, 'device disposal does not release the owned pipeline');
    t.equal(pipeline.entry, 'kernel_main');
    t.equal(pipeline.threadExecutionWidth, 32);
    t.equal(pipeline.maxThreadsPerThreadgroup, 256);
    pipeline.close();
    pipeline.close();
    t.equal(released, 1);
  });
  it('releases a compilation result if its device closes while pending', async (t) => {
    let finish: (value: any) => void;
    let released = 0;
    const api = {
      createDevice: () => new ArrayBuffer(8),
      info: () => ({ name: 'fake', unifiedMemory: true, maxBufferLength: 1024 }),
      createBuffer: () => null,
      contents: () => null,
      retain: (value: ArrayBuffer) => value,
      release: () => {},
      compile: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    const device = openDevice(api)!;
    const result = device.compile('source', 'main');
    device.close();
    finish!({
      pointer: new ArrayBuffer(8),
      threadExecutionWidth: 32,
      maxThreadsPerThreadgroup: 256,
      close: () => released++,
    });
    await t.rejects(() => result, /closed/);
    t.equal(released, 1);
    await t.rejects(() => device.compile('source', 'main'), /closed/);
  });
  it('compiles shared fixtures concurrently and reports invalid source and entry points', async (t) => {
    using device = openDevice();
    if (!device) {
      t.ok(env.FINO_REQUIRE_METAL_DEVICE !== '1', 'Metal device is required');
      return;
    }
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const kernels = fixtures();
      const pipelines = await Promise.all(
        kernels.map((ir) => device.compile(lowerToMSL(ir), ir.name)),
      );
      try {
        for (let i = 0; i < pipelines.length; i++) {
          t.equal(pipelines[i].entry, kernels[i].name);
          t.ok(pipelines[i].threadExecutionWidth > 0);
          t.ok(pipelines[i].maxThreadsPerThreadgroup >= pipelines[i].threadExecutionWidth);
        }
        t.ok(ticks > 0, 'event loop progresses during compilation');
      } finally {
        for (const pipeline of pipelines) {
          pipeline.close();
          pipeline.close();
        }
      }
      await t.rejects(() => device.compile('invalid metal source', 'main'), /compil/i);
      await t.rejects(
        () => device.compile(lowerToMSL(kernels[0]), 'missing_entry'),
        /missing_entry/,
      );
    } finally {
      clearInterval(timer);
    }
  });
});
