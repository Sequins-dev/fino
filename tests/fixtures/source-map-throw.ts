type Value = number;

interface Payload {
  value: Value;
}

function unwrap(payload: Payload): number {
  return payload.value;
}

export function throwFromTypedTs(): never {
  const payload: Payload = { value: 42 };
  const value: Value = unwrap(payload);
  if (value !== 42) {
    throw new Error('unexpected');
  }

  throw new Error('typed boom');
}
