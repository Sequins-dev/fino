const _registry = new Map<string, Record<string, unknown>>();

export function _register(spec: string, exports: Record<string, unknown>): void {
  if (_registry.has(spec)) throw new Error(`SyntheticModule already installed: ${spec}`);
  _registry.set(spec, exports);
}

export function _unregister(spec: string): void {
  if (!_registry.delete(spec)) throw new Error(`SyntheticModule not installed: ${spec}`);
}

export function __direct(spec: string, name: string): unknown {
  const r = _registry.get(spec);
  if (r === undefined) throw new Error(`SyntheticModule not installed: ${spec}`);
  return r[name];
}
