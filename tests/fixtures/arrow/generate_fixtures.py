#!/usr/bin/env python3
"""Generate Arrow IPC golden fixtures for fino:data/arrow interop tests.

pyarrow is not installed on the primary dev machine, so this script is run
wherever pyarrow is available (e.g. `uvx --with pyarrow python generate_fixtures.py`)
and the resulting `.arrows` (stream) and `.arrow` (file) binaries are committed
next to it. The fino test `tests/data/arrow-golden.test.ts` reads them and skips
gracefully when they are absent.

It also reads back a fino-written file (`fino_roundtrip.arrows`, produced by the
fino test suite when RUN with FINO_WRITE_ARROW_GOLDEN=1) to validate the fino
writer against pyarrow in the other direction.
"""
import os
import pyarrow as pa
import pyarrow.ipc as ipc

HERE = os.path.dirname(os.path.abspath(__file__))


def write(name, table):
    with pa.OSFile(os.path.join(HERE, name + ".arrows"), "wb") as sink:
        with ipc.new_stream(sink, table.schema) as writer:
            writer.write_table(table)
    with pa.OSFile(os.path.join(HERE, name + ".arrow"), "wb") as sink:
        with ipc.new_file(sink, table.schema) as writer:
            writer.write_table(table)


def main():
    write("primitives", pa.table({
        "i8": pa.array([1, -2, 3, None], pa.int8()),
        "i32": pa.array([1, 2, 3, 4], pa.int32()),
        "i64": pa.array([1, 2, 2**53 + 1, None], pa.int64()),
        "f64": pa.array([1.5, 2.25, None, 4.0], pa.float64()),
        "b": pa.array([True, False, True, None], pa.bool_()),
    }))
    write("strings", pa.table({
        "s": pa.array(["alpha", "", "grüße", None], pa.string()),
        "big": pa.array(["x", "yy", "zzz", "wwww"], pa.large_string()),
    }))
    write("nested", pa.table({
        "list": pa.array([[1, 2], [], [3, 4, 5], None], pa.list_(pa.int32())),
        "struct": pa.array([{"a": 1, "b": "x"}, {"a": 2, "b": "y"}, None, {"a": 4, "b": "z"}]),
    }))
    write("dictionary", pa.table({
        "color": pa.array(["red", "green", "red", "blue"]).dictionary_encode(),
    }))

    roundtrip = os.path.join(HERE, "fino_roundtrip.arrows")
    if os.path.exists(roundtrip):
        with pa.OSFile(roundtrip, "rb") as src:
            table = ipc.open_stream(src).read_all()
        print("fino round-trip file read by pyarrow:", table.num_rows, "rows,", table.schema)


if __name__ == "__main__":
    main()
