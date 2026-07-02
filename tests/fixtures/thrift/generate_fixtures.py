#!/usr/bin/env python3
"""Generate Thrift golden fixtures for internal:format/thrift interop tests.

The reference Apache Thrift Python package is not assumed present on the dev
machine, so this script is run wherever it is available
(`uvx --with thrift python generate_fixtures.py`) and the resulting `.compact`
and `.binary` byte files are committed next to it. The fino test
`tests/format/thrift-golden.test.ts` reads them and skips gracefully when absent.

It drives the low-level TProtocol directly (no generated code) to serialize a
fixed struct that exercises the common types.
"""
import os
from thrift.transport.TTransport import TMemoryBuffer
from thrift.protocol.TCompactProtocol import TCompactProtocol
from thrift.protocol.TBinaryProtocol import TBinaryProtocol
from thrift.protocol.TProtocol import TType

HERE = os.path.dirname(os.path.abspath(__file__))


def write_struct(proto):
    proto.writeStructBegin("Golden")
    proto.writeFieldBegin("a", TType.I32, 1)
    proto.writeI32(42)
    proto.writeFieldEnd()
    proto.writeFieldBegin("b", TType.STRING, 2)
    proto.writeString("héllo")
    proto.writeFieldEnd()
    proto.writeFieldBegin("c", TType.LIST, 3)
    proto.writeListBegin(TType.I32, 3)
    for v in (1, 2, 3):
        proto.writeI32(v)
    proto.writeListEnd()
    proto.writeFieldEnd()
    proto.writeFieldBegin("d", TType.BOOL, 4)
    proto.writeBool(True)
    proto.writeFieldEnd()
    proto.writeFieldBegin("e", TType.I64, 5)
    proto.writeI64(1 << 40)
    proto.writeFieldEnd()
    proto.writeFieldStop()
    proto.writeStructEnd()


def emit(name, proto_cls):
    buf = TMemoryBuffer()
    write_struct(proto_cls(buf))
    with open(os.path.join(HERE, name), "wb") as f:
        f.write(buf.getvalue())


def main():
    emit("golden.compact", TCompactProtocol)
    emit("golden.binary", TBinaryProtocol)
    print("wrote golden.compact and golden.binary")


if __name__ == "__main__":
    main()
