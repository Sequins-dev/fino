/** Minimal pprof inspection shared by profiling regression fixtures. */
const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
interface ProtobufField {
  number: number;
  value: number | Uint8Array;
}

function readVarint(bytes: Uint8Array, offset: { value: number }): number {
  let value = 0;
  let shift = 0;
  while (offset.value < bytes.byteLength) {
    const byte = bytes[offset.value++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
  throw new Error('truncated protobuf varint');
}

function protobufFields(bytes: Uint8Array): ProtobufField[] {
  const fields: ProtobufField[] = [];
  const offset = { value: 0 };
  while (offset.value < bytes.byteLength) {
    const tag = readVarint(bytes, offset);
    const number = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (wireType === 0) {
      fields.push({ number, value: readVarint(bytes, offset) });
      continue;
    }
    if (wireType === 2) {
      const length = readVarint(bytes, offset);
      const end = offset.value + length;
      if (end > bytes.byteLength) throw new Error('truncated protobuf field');
      fields.push({ number, value: bytes.slice(offset.value, end) });
      offset.value = end;
      continue;
    }
    throw new Error(`unsupported protobuf wire type ${wireType}`);
  }
  return fields;
}

export function pprofThreadLabels(bytes: Uint8Array): string[] {
  const fields = protobufFields(bytes);
  const strings = fields
    .filter((field) => field.number === 6)
    .map((field) => decodeUtf8(field.value as Uint8Array));
  const labels: string[] = [];
  for (const sample of fields.filter((field) => field.number === 2)) {
    for (const label of protobufFields(sample.value as Uint8Array).filter(
      (field) => field.number === 3,
    )) {
      const labelFields = protobufFields(label.value as Uint8Array);
      const key = labelFields.find((field) => field.number === 1)?.value;
      const value = labelFields.find((field) => field.number === 2)?.value;
      if (typeof key === 'number' && strings[key] === 'thread' && typeof value === 'number') {
        const text = strings[value];
        if (text !== undefined) labels.push(text);
      }
    }
  }
  return labels;
}
export function pprofFunctionSampleCounts(bytes: Uint8Array): Map<string, number> {
  const fields = protobufFields(bytes);
  const strings = fields
    .filter((f) => f.number === 6)
    .map((f) => decodeUtf8(f.value as Uint8Array));
  const functions = new Map<number, string>();
  const locations = new Map<number, number[]>();
  for (const field of fields.filter((f) => f.number === 5)) {
    const values = protobufFields(field.value as Uint8Array);
    functions.set(
      values.find((f) => f.number === 1)!.value as number,
      strings[values.find((f) => f.number === 2)!.value as number]!,
    );
  }
  for (const field of fields.filter((f) => f.number === 4)) {
    const values = protobufFields(field.value as Uint8Array);
    locations.set(
      values.find((f) => f.number === 1)!.value as number,
      values
        .filter((f) => f.number === 4)
        .map(
          (f) =>
            protobufFields(f.value as Uint8Array).find((line) => line.number === 1)!
              .value as number,
        ),
    );
  }
  const counts = new Map<string, number>();
  for (const field of fields.filter((f) => f.number === 2)) {
    const values = protobufFields(field.value as Uint8Array);
    const packed = values.find((f) => f.number === 1)?.value as Uint8Array | undefined;
    if (!packed) continue;
    const count = readVarint(values.find((f) => f.number === 2)!.value as Uint8Array, { value: 0 });
    const offset = { value: 0 };
    const names = new Set<string>();
    while (offset.value < packed.byteLength) {
      for (const id of locations.get(readVarint(packed, offset)) ?? []) {
        const name = functions.get(id);
        if (name) names.add(name);
      }
    }
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + count);
  }
  return counts;
}
