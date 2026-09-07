/**
 * Apple arm64 Metal allocation adapter. Framework handles and typed message
 * bindings are cached in the importing Realm. Calls stay inside synchronous
 * autorelease scopes; owned Create/new results escape without an extra retain.
 *
 * References:
 * - [Device ownership](https://github.com/apple/metal-cpp#memory-allocation-policy)
 * - [Default device](https://developer.apple.com/documentation/metal/mtlcreatesystemdefaultdevice())
 *
 * @internal
 */
import { dlopen, Pointer } from 'fino:ffi';
import {
  available,
  bindMessage,
  selector,
  retain,
  release,
  withAutoreleasePool,
} from 'internal:objc';
import type { MetalMemoryApi } from './memory.ts';

function load() {
  // Apple's default-device lookup requires CoreGraphics in command-line hosts.
  const graphics = dlopen('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics', {});
  const metal = dlopen('/System/Library/Frameworks/Metal.framework/Metal', {
    MTLCreateSystemDefaultDevice: { parameters: [], result: 'pointer' },
  });
  const ptr = bindMessage({ parameters: [], result: 'pointer' });
  const size = bindMessage({ parameters: [], result: 'usize' });
  const bool = bindMessage({ parameters: [], result: 'bool' });
  const encodedLength = bindMessage({ parameters: ['usize'], result: 'usize' });
  const allocate = bindMessage({ parameters: ['usize', 'usize'], result: 'pointer' });
  const names = {
    name: selector('name'),
    utf8: selector('UTF8String'),
    encodedLength: selector('lengthOfBytesUsingEncoding:'),
    unified: selector('hasUnifiedMemory'),
    max: selector('maxBufferLength'),
    allocate: selector('newBufferWithLength:options:'),
    contents: selector('contents'),
  };
  const api: MetalMemoryApi = {
    createDevice: () => withAutoreleasePool(() => metal.symbols.MTLCreateSystemDefaultDevice()),
    info: (device) =>
      withAutoreleasePool(() => {
        const string = ptr(device, names.name);
        const address = string ? ptr(string, names.utf8) : null;
        const length = string ? encodedLength(string, names.encodedLength, 4) : 0;
        return {
          name: address ? new TextDecoder().decode(Pointer.copyFrom(address, length)) : 'Metal',
          unifiedMemory: bool(device, names.unified),
          maxBufferLength: size(device, names.max),
        };
      }),
    createBuffer: (device, bytes) =>
      withAutoreleasePool(() => allocate(device, names.allocate, bytes, 0)),
    contents: (buffer) => ptr(buffer, names.contents),
    retain,
    release: (object) => withAutoreleasePool(() => release(object)),
  };
  return { graphics, metal, api };
}
let loaded: ReturnType<typeof load> | undefined;

/** Return the Realm's native adapter, or null before loading on unsupported platforms. */
export function nativeMemoryApi(): MetalMemoryApi | null {
  if (!available()) return null;
  loaded ??= load();
  return loaded.api;
}
