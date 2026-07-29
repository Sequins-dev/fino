#!/usr/bin/env python3
"""Generate committed Parquet interoperability fixtures.

Run with the pinned external writers used by the compatibility gate:

    uvx --with pyarrow==20.0.0 --with duckdb==1.3.2 \
        python tests/fixtures/parquet/generate_fixtures.py

The generated files are committed and required by
`tests/data/parquet-golden.test.ts`. PyArrow covers logical types, encodings,
compression, nesting, and row groups. DuckDB supplies an independent analytics
writer so the suite does not accidentally encode PyArrow-specific behavior.
"""
import datetime
import decimal
import os

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

HERE = os.path.dirname(os.path.abspath(__file__))


def write(name, table, **kwargs):
    pq.write_table(table, os.path.join(HERE, name), **kwargs)


def main():
    write(
        "primitives.parquet",
        pa.table(
            {
                "i32": pa.array([1, 2, 3, None], pa.int32()),
                "i64": pa.array([1, 2, 2**53 + 1, None], pa.int64()),
                "f64": pa.array([1.5, 2.25, None, 4.0], pa.float64()),
                "b": pa.array([True, False, True, None], pa.bool_()),
                "s": pa.array(["alpha", "grüße", "", None], pa.string()),
            }
        ),
    )
    # Low-cardinality column: pyarrow dictionary-encodes it by default.
    write(
        "dictionary.parquet",
        pa.table(
            {
                "color": pa.array(
                    ["red", "green", "red", "blue", "green"] * 20,
                    pa.string(),
                ),
            }
        ),
    )
    write(
        "uncompressed.parquet",
        pa.table({"x": pa.array(list(range(100)), pa.int32())}),
        compression="none",
    )
    write(
        "gzip.parquet",
        pa.table({"x": pa.array(list(range(100)), pa.int32())}),
        compression="gzip",
    )
    write(
        "nested.parquet",
        pa.table(
            {
                "tags": pa.array(
                    [["a", "b"], [], ["c"], None],
                    pa.list_(pa.string()),
                ),
                "point": pa.array(
                    [
                        {"x": 1, "y": 2},
                        {"x": 3, "y": 4},
                        None,
                        {"x": 5, "y": 6},
                    ],
                    pa.struct([("x", pa.int32()), ("y", pa.int32())]),
                ),
            }
        ),
    )
    write(
        "logical-types.parquet",
        pa.table(
            {
                "decimal": pa.array(
                    [
                        decimal.Decimal("1.2345"),
                        decimal.Decimal("-6.7890"),
                        None,
                    ],
                    pa.decimal128(20, 4),
                ),
                "date": pa.array(
                    [
                        datetime.date(1970, 1, 1),
                        datetime.date(1970, 1, 2),
                        None,
                    ],
                    pa.date32(),
                ),
                "time": pa.array(
                    [
                        datetime.time(0, 0, 0),
                        datetime.time(0, 0, 1, 500000),
                        None,
                    ],
                    pa.time32("ms"),
                ),
                "timestamp": pa.array(
                    [
                        datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc),
                        datetime.datetime(
                            1970,
                            1,
                            1,
                            0,
                            0,
                            1,
                            tzinfo=datetime.timezone.utc,
                        ),
                        None,
                    ],
                    pa.timestamp("us", tz="UTC"),
                ),
                "uint32": pa.array([0, 4_000_000_000, None], pa.uint32()),
            }
        ),
    )
    write(
        "delta.parquet",
        pa.table(
            {
                "value": pa.array(
                    [i * 7 - 500 for i in range(300)],
                    pa.int32(),
                )
            }
        ),
        compression="none",
        use_dictionary=False,
        column_encoding={"value": "DELTA_BINARY_PACKED"},
        data_page_version="2.0",
    )
    write(
        "byte-stream-split.parquet",
        pa.table(
            {
                "value": pa.array(
                    [i * 1.25 for i in range(128)],
                    pa.float64(),
                )
            }
        ),
        compression="none",
        use_dictionary=False,
        use_byte_stream_split=True,
        data_page_version="2.0",
    )
    write(
        "row-groups.parquet",
        pa.table(
            {
                "value": pa.array(list(range(10)), pa.int32()),
                "category": pa.array(["a"] * 4 + ["b"] * 4 + ["c"] * 2),
            }
        ),
        compression="none",
        row_group_size=4,
        write_statistics=True,
    )

    duckdb_path = os.path.join(HERE, "duckdb.parquet").replace("'", "''")
    with duckdb.connect() as db:
        db.execute(
            f"""
            COPY (
                SELECT *
                FROM (
                    VALUES
                        (1::INTEGER, 'alpha'::VARCHAR, 1.5::DOUBLE),
                        (2::INTEGER, 'beta'::VARCHAR, 2.25::DOUBLE),
                        (3::INTEGER, NULL::VARCHAR, NULL::DOUBLE)
                ) AS rows(id, label, score)
            ) TO '{duckdb_path}' (
                FORMAT PARQUET,
                COMPRESSION UNCOMPRESSED
            )
            """
        )
    print("wrote parquet fixtures")


if __name__ == "__main__":
    main()
