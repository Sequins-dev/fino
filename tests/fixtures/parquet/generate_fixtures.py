#!/usr/bin/env python3
"""Generate Parquet golden fixtures for fino:data/parquet interop tests.

pyarrow is not assumed present on the dev machine, so run this wherever it is
available (`uvx --with pyarrow python generate_fixtures.py`) and commit the
resulting `.parquet` files. The fino test `tests/data/parquet-golden.test.ts`
reads them and skips gracefully when absent.

pyarrow writes dictionary-encoded, Snappy-compressed pages by default, so these
fixtures exercise the reader's real-file paths (dictionary decode + Snappy).
"""
import os
import pyarrow as pa
import pyarrow.parquet as pq

HERE = os.path.dirname(os.path.abspath(__file__))


def write(name, table, **kwargs):
    pq.write_table(table, os.path.join(HERE, name), **kwargs)


def main():
    write("primitives.parquet", pa.table({
        "i32": pa.array([1, 2, 3, None], pa.int32()),
        "i64": pa.array([1, 2, 2**53 + 1, None], pa.int64()),
        "f64": pa.array([1.5, 2.25, None, 4.0], pa.float64()),
        "b": pa.array([True, False, True, None], pa.bool_()),
        "s": pa.array(["alpha", "grüße", "", None], pa.string()),
    }))
    # Low-cardinality column: pyarrow dictionary-encodes it by default.
    write("dictionary.parquet", pa.table({
        "color": pa.array(["red", "green", "red", "blue", "green"] * 20, pa.string()),
    }))
    write("uncompressed.parquet", pa.table({
        "x": pa.array(list(range(100)), pa.int32()),
    }), compression="none")
    write("gzip.parquet", pa.table({
        "x": pa.array(list(range(100)), pa.int32()),
    }), compression="gzip")
    write("nested.parquet", pa.table({
        "tags": pa.array([["a", "b"], [], ["c"], None], pa.list_(pa.string())),
        "point": pa.array([{"x": 1, "y": 2}, {"x": 3, "y": 4}, None, {"x": 5, "y": 6}],
                          pa.struct([("x", pa.int32()), ("y", pa.int32())])),
    }))
    print("wrote parquet fixtures")


if __name__ == "__main__":
    main()
