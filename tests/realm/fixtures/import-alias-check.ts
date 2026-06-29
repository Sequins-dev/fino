/**
* Fixture: imports via a virtual specifier that should be remapped by the parent's ImportMap.
* Returns true if the import succeeded and the module had Pointer exported (fino:ffi shape),
* false if the import threw.
*/
let remapped = false;
try {
  const mod = await import('virtual:utils') as {
    Pointer?: unknown;
  };
  remapped = 'Pointer' in mod;
} catch {}
export default function() {
  return remapped;
}
