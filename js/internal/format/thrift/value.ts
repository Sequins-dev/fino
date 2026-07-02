/**
* Protocol-agnostic helpers over the `Protocol` interface: `skip()` for
* discarding a value of a known type (essential for forward compatibility —
* unknown Thrift fields are skipped), and a generic tagged value model
* (`ThriftValue`) with symmetric `readValue`/`writeValue` and
* `readStruct`/`writeStruct` so arbitrary Thrift can be round-tripped without
* hand-driving every field.
*
* @internal
*/
import { type Protocol } from './protocol.ts';
import { TType } from './types.ts';
/**
* A self-describing Thrift value. Container variants carry their element types
* so a value read from one protocol can be written to another.
*
* @internal
*/
export type ThriftValue = {
  type: 2;
  value: boolean;
} | {
  type: 3;
  value: number;
} | {
  type: 6;
  value: number;
} | {
  type: 8;
  value: number;
} | {
  type: 10;
  value: bigint;
} | {
  type: 4;
  value: number;
} | {
  type: 11;
  value: string;
} | {
  type: 12;
  fields: Map<number, ThriftValue>;
} | {
  type: 15;
  elemType: number;
  values: ThriftValue[];
} | {
  type: 14;
  elemType: number;
  values: ThriftValue[];
} | {
  type: 13;
  keyType: number;
  valueType: number;
  entries: [ThriftValue, ThriftValue][];
};
/**
* Read and discard a value of the given `TType`, recursing through structs and
* containers. Leaves the cursor at the byte after the value.
*
* @internal
*/
export function skip(protocol: Protocol, type: number): void {
  switch (type) {
    case TType.BOOL:
      protocol.readBool();
      return;
    case TType.BYTE:
      protocol.readByte();
      return;
    case TType.I16:
      protocol.readI16();
      return;
    case TType.I32:
      protocol.readI32();
      return;
    case TType.I64:
      protocol.readI64();
      return;
    case TType.DOUBLE:
      protocol.readDouble();
      return;
    case TType.STRING:
      protocol.readBinary();
      return;
    case TType.STRUCT: {
      protocol.readStructBegin();
      for (;;) {
        const field = protocol.readFieldBegin();
        if (field.type === TType.STOP) break;
        skip(protocol, field.type);
        protocol.readFieldEnd();
      }
      protocol.readStructEnd();
      return;
    }
    case TType.MAP: {
      const header = protocol.readMapBegin();
      for (let i = 0; i < header.size; i++) {
        skip(protocol, header.keyType);
        skip(protocol, header.valueType);
      }
      protocol.readMapEnd();
      return;
    }
    case TType.SET: {
      const header = protocol.readSetBegin();
      for (let i = 0; i < header.size; i++) skip(protocol, header.elemType);
      protocol.readSetEnd();
      return;
    }
    case TType.LIST: {
      const header = protocol.readListBegin();
      for (let i = 0; i < header.size; i++) skip(protocol, header.elemType);
      protocol.readListEnd();
      return;
    }
    default: throw new TypeError(`thrift: cannot skip type ${type}`);
  }
}
/**
* Read a single value of the given `TType` into a `ThriftValue`. STRING is
* decoded as text; drive binary fields with `protocol.readBinary()` directly
* when raw bytes matter.
*
* @internal
*/
export function readValue(protocol: Protocol, type: number): ThriftValue {
  switch (type) {
    case TType.BOOL: return {
      type: TType.BOOL,
      value: protocol.readBool()
    };
    case TType.BYTE: return {
      type: TType.BYTE,
      value: protocol.readByte()
    };
    case TType.I16: return {
      type: TType.I16,
      value: protocol.readI16()
    };
    case TType.I32: return {
      type: TType.I32,
      value: protocol.readI32()
    };
    case TType.I64: return {
      type: TType.I64,
      value: protocol.readI64()
    };
    case TType.DOUBLE: return {
      type: TType.DOUBLE,
      value: protocol.readDouble()
    };
    case TType.STRING: return {
      type: TType.STRING,
      value: protocol.readString()
    };
    case TType.STRUCT: return {
      type: TType.STRUCT,
      fields: readStruct(protocol)
    };
    case TType.LIST: {
      const header = protocol.readListBegin();
      const values: ThriftValue[] = [];
      for (let i = 0; i < header.size; i++) values.push(readValue(protocol, header.elemType));
      protocol.readListEnd();
      return {
        type: TType.LIST,
        elemType: header.elemType,
        values
      };
    }
    case TType.SET: {
      const header = protocol.readSetBegin();
      const values: ThriftValue[] = [];
      for (let i = 0; i < header.size; i++) values.push(readValue(protocol, header.elemType));
      protocol.readSetEnd();
      return {
        type: TType.SET,
        elemType: header.elemType,
        values
      };
    }
    case TType.MAP: {
      const header = protocol.readMapBegin();
      const entries: [ThriftValue, ThriftValue][] = [];
      for (let i = 0; i < header.size; i++) {
        entries.push([readValue(protocol, header.keyType), readValue(protocol, header.valueType)]);
      }
      protocol.readMapEnd();
      return {
        type: TType.MAP,
        keyType: header.keyType,
        valueType: header.valueType,
        entries
      };
    }
    default: throw new TypeError(`thrift: cannot read value of type ${type}`);
  }
}
/**
* Write a `ThriftValue` (the inverse of `readValue`).
*
* @internal
*/
export function writeValue(protocol: Protocol, value: ThriftValue): void {
  switch (value.type) {
    case TType.BOOL:
      protocol.writeBool(value.value);
      return;
    case TType.BYTE:
      protocol.writeByte(value.value);
      return;
    case TType.I16:
      protocol.writeI16(value.value);
      return;
    case TType.I32:
      protocol.writeI32(value.value);
      return;
    case TType.I64:
      protocol.writeI64(value.value);
      return;
    case TType.DOUBLE:
      protocol.writeDouble(value.value);
      return;
    case TType.STRING:
      protocol.writeString(value.value);
      return;
    case TType.STRUCT:
      writeStruct(protocol, value.fields);
      return;
    case TType.LIST:
      protocol.writeListBegin(value.elemType, value.values.length);
      for (const item of value.values) writeValue(protocol, item);
      protocol.writeListEnd();
      return;
    case TType.SET:
      protocol.writeSetBegin(value.elemType, value.values.length);
      for (const item of value.values) writeValue(protocol, item);
      protocol.writeSetEnd();
      return;
    case TType.MAP:
      protocol.writeMapBegin(value.keyType, value.valueType, value.entries.length);
      for (const [k, v] of value.entries) {
        writeValue(protocol, k);
        writeValue(protocol, v);
      }
      protocol.writeMapEnd();
      return;
  }
}
/**
* Read a struct into a map of field id → value.
*
* @internal
*/
export function readStruct(protocol: Protocol): Map<number, ThriftValue> {
  const fields = new Map<number, ThriftValue>();
  protocol.readStructBegin();
  for (;;) {
    const field = protocol.readFieldBegin();
    if (field.type === TType.STOP) break;
    fields.set(field.id, readValue(protocol, field.type));
    protocol.readFieldEnd();
  }
  protocol.readStructEnd();
  return fields;
}
/**
* Write a map of field id → value as a struct.
*
* @internal
*/
export function writeStruct(protocol: Protocol, fields: Map<number, ThriftValue>): void {
  protocol.writeStructBegin();
  for (const [id, value] of fields) {
    protocol.writeFieldBegin('', value.type, id);
    writeValue(protocol, value);
    protocol.writeFieldEnd();
  }
  protocol.writeFieldStop();
  protocol.writeStructEnd();
}
