/**
 * Asynchronous Metal compilation through owned Objective-C completion blocks.
 * Inputs have independent native references in each outstanding block. Callback
 * results are retained before the native callback returns and are rooted with
 * FfiResource, including when the Realm shuts down before consuming the result.
 * No autorelease pool crosses an await. Native compilation cannot be cancelled;
 * disposing a device discards its eventual result in the ownership layer.
 *
 * References:
 * - [Asynchronous libraries](https://developer.apple.com/documentation/metal/mtldevice/makelibrary(source:options:completionhandler:))
 * - [Asynchronous pipelines](https://developer.apple.com/documentation/metal/mtldevice/makecomputepipelinestate(function:completionhandler:))
 *
 * @internal
 */
import { dlopen, FfiCallback, FfiResource, Pointer } from 'fino:ffi';
import { bindMessage, getClass, selector, retain, withAutoreleasePool } from 'internal:objc';
import type { ObjectHandle } from 'internal:objc';
import type { CompiledMetalPipeline } from './memory.ts';

/** Create a Realm-local adapter; the runtime and framework must already be loaded. */
export function createCompiler() {
  const objc = dlopen('/usr/lib/libobjc.A.dylib', {
    objc_release: { parameters: ['pointer'], result: 'void' },
  });
  const ptr = bindMessage({ parameters: [], result: 'pointer' });
  const ptrPtr = bindMessage({ parameters: ['pointer'], result: 'pointer' });
  const size = bindMessage({ parameters: [], result: 'usize' });
  const byteLength = bindMessage({ parameters: ['usize'], result: 'usize' });
  const stringInit = bindMessage({ parameters: ['buffer', 'usize', 'usize'], result: 'pointer' });
  const setBool = bindMessage({ parameters: ['bool'], result: 'void' });
  const setSize = bindMessage({ parameters: ['usize'], result: 'void' });
  // Completion APIs may invoke a callback immediately; they must not use Fast API.
  const libraryStart = bindMessage({
    parameters: ['pointer', 'pointer', 'pointer'],
    result: 'void',
    fast: false,
  });
  const pipelineStart = bindMessage({
    parameters: ['pointer', 'pointer'],
    result: 'void',
    fast: false,
  });
  const own = (pointer: ObjectHandle) => new FfiResource(pointer, objc.pointers.objc_release);
  const text = (value: ObjectHandle): string => {
    const length = byteLength(value, selector('lengthOfBytesUsingEncoding:'), 4);
    const data = ptr(value, selector('UTF8String'));
    return data ? new TextDecoder().decode(Pointer.copyFrom(data, length)) : '';
  };
  const string = (value: string) =>
    withAutoreleasePool(() => {
      const bytes = new TextEncoder().encode(value);
      const allocated = ptr(getClass('NSString'), selector('alloc'));
      const result = stringInit(
        allocated,
        selector('initWithBytes:length:encoding:'),
        bytes,
        bytes.length,
        4,
      );
      if (!result) throw new Error('Metal could not create a source string');
      return own(result);
    });

  async function completion(start: (block: ObjectHandle) => void, inputs: ObjectHandle[]) {
    let callback: InstanceType<typeof FfiCallback> | undefined;
    let block: ReturnType<InstanceType<typeof FfiCallback>['block']> | undefined;
    // A callback registration alone is not an event-loop liveness reference.
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      return await new Promise<InstanceType<typeof FfiResource>>((resolve, reject) => {
        callback = new FfiCallback(
          { parameters: ['pointer', 'pointer'], result: 'void' },
          (result, error) => {
            try {
              withAutoreleasePool(() => {
                if (result) resolve(own(retain(result)));
                else {
                  const description = error ? ptr(error, selector('localizedDescription')) : null;
                  reject(
                    new Error(
                      `Metal compilation failed: ${description ? text(description) : 'no result'}`,
                    ),
                  );
                }
              });
            } catch (error) {
              reject(error);
            }
          },
        );
        block = callback.block(
          inputs.map((pointer) => ({
            pointer: retain(pointer),
            release: objc.pointers.objc_release,
          })),
        );
        withAutoreleasePool(() => start(block!.pointer));
      });
    } finally {
      clearInterval(keepAlive);
      callback?.close();
      block?.close();
    }
  }

  return async (
    device: ObjectHandle,
    source: string,
    entry: string,
  ): Promise<CompiledMetalPipeline> => {
    using deviceOwner = own(retain(device));
    using sourceString = string(source);
    using options = withAutoreleasePool(() => {
      const value = own(ptr(getClass('MTLCompileOptions'), selector('new')));
      try {
        setBool(value.pointer, selector('setFastMathEnabled:'), false);
        setSize(value.pointer, selector('setLanguageVersion:'), 3 << 16);
        return value;
      } catch (error) {
        value.close();
        throw error;
      }
    });
    using library = await completion(
      (block) =>
        libraryStart(
          deviceOwner.pointer,
          selector('newLibraryWithSource:options:completionHandler:'),
          sourceString.pointer,
          options.pointer,
          block,
        ),
      [deviceOwner.pointer, sourceString.pointer, options.pointer],
    );
    using entryString = string(entry);
    const functionPointer = withAutoreleasePool(() =>
      ptrPtr(library.pointer, selector('newFunctionWithName:'), entryString.pointer),
    );
    if (!functionPointer) throw new Error(`Metal library has no entry point '${entry}'`);
    using fn = own(functionPointer);
    const pipeline = await completion(
      (block) =>
        pipelineStart(
          deviceOwner.pointer,
          selector('newComputePipelineStateWithFunction:completionHandler:'),
          fn.pointer,
          block,
        ),
      [deviceOwner.pointer, library.pointer, fn.pointer],
    );
    try {
      return {
        pointer: pipeline.pointer,
        threadExecutionWidth: size(pipeline.pointer, selector('threadExecutionWidth')),
        maxThreadsPerThreadgroup: size(pipeline.pointer, selector('maxTotalThreadsPerThreadgroup')),
        close: () => pipeline.close(),
      };
    } catch (error) {
      pipeline.close();
      throw error;
    }
  };
}
