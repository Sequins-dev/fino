//! pprof protobuf encoder — port of DataDog/pprof-format (MIT).
//!
//! Schema: <https://github.com/google/pprof/blob/main/proto/profile.proto>
//!
//! Only two wire types are used (sufficient for the pprof schema):
//!   - wire type 0: varint (i64, u64, bool)
//!   - wire type 2: length-delimited (submessages, packed repeated, strings)
//!
//! All pprof field numbers are < 16, so every tag fits in a single byte.

use crate::protobuf::{
    encode_length_delimited, encode_packed_i64, encode_packed_u64, encode_sint64_field,
    encode_string_field, encode_varint_field,
};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// StringTable
// ---------------------------------------------------------------------------

pub struct StringTable {
    pub strings: Vec<String>,
    indices: HashMap<String, u64>,
}

impl StringTable {
    pub fn new() -> Self {
        let mut st = StringTable {
            strings: Vec::new(),
            indices: HashMap::new(),
        };
        st.intern(""); // index 0 must be empty string (pprof requirement)
        st
    }

    pub fn intern(&mut self, s: &str) -> u64 {
        if let Some(&idx) = self.indices.get(s) {
            return idx;
        }
        let idx = self.strings.len() as u64;
        self.strings.push(s.to_string());
        self.indices.insert(s.to_string(), idx);
        idx
    }
}

// ---------------------------------------------------------------------------
// pprof message types
// ---------------------------------------------------------------------------

pub struct ValueType {
    pub r#type: u64,
    pub unit: u64,
}

impl ValueType {
    fn encode(&self, buf: &mut Vec<u8>) {
        encode_varint_field(buf, 1, self.r#type);
        encode_varint_field(buf, 2, self.unit);
    }
}

pub struct Line {
    pub function_id: u64,
    pub line: i64,
}

impl Line {
    fn encode(&self, buf: &mut Vec<u8>) {
        encode_varint_field(buf, 1, self.function_id);
        encode_sint64_field(buf, 2, self.line);
    }
}

pub struct Location {
    pub id: u64,
    pub lines: Vec<Line>,
}

impl Location {
    fn encode(&self, buf: &mut Vec<u8>) {
        encode_varint_field(buf, 1, self.id);
        for line in &self.lines {
            let mut inner = Vec::new();
            line.encode(&mut inner);
            encode_length_delimited(buf, 4, &inner);
        }
    }
}

pub struct Function {
    pub id: u64,
    pub name: u64,
    pub system_name: u64,
    pub filename: u64,
    pub start_line: i64,
}

impl Function {
    fn encode(&self, buf: &mut Vec<u8>) {
        encode_varint_field(buf, 1, self.id);
        encode_varint_field(buf, 2, self.name);
        encode_varint_field(buf, 3, self.system_name);
        encode_varint_field(buf, 4, self.filename);
        encode_sint64_field(buf, 5, self.start_line);
    }
}

pub struct Sample {
    pub location_ids: Vec<u64>,
    pub values: Vec<i64>,
    pub labels: Vec<Label>,
}

impl Sample {
    fn encode(&self, buf: &mut Vec<u8>) {
        encode_packed_u64(buf, 1, &self.location_ids);
        encode_packed_i64(buf, 2, &self.values);
        for label in &self.labels {
            let mut inner = Vec::new();
            label.encode(&mut inner);
            encode_length_delimited(buf, 3, &inner);
        }
    }
}

/// A string-valued pprof sample label.
///
/// The schema also permits numeric labels, but CPU Realm profiles only need
/// the string form used by pprof's recognized `thread` tag.
pub struct Label {
    pub key: u64,
    pub str: u64,
}

impl Label {
    fn encode(&self, buf: &mut Vec<u8>) {
        encode_varint_field(buf, 1, self.key);
        encode_varint_field(buf, 2, self.str);
    }
}

// ---------------------------------------------------------------------------
// Profile encoder
// ---------------------------------------------------------------------------

pub struct ProfileEncoder {
    pub strings: StringTable,
    pub value_types: Vec<ValueType>,
    pub samples: Vec<Sample>,
    pub locations: Vec<Location>,
    pub functions: Vec<Function>,
    pub time_nanos: i64,
    pub duration_nanos: i64,
    pub period_type: ValueType,
    pub period: i64,
}

impl ProfileEncoder {
    pub fn new() -> Self {
        ProfileEncoder {
            strings: StringTable::new(),
            value_types: Vec::new(),
            samples: Vec::new(),
            locations: Vec::new(),
            functions: Vec::new(),
            time_nanos: 0,
            duration_nanos: 0,
            period_type: ValueType { r#type: 0, unit: 0 },
            period: 0,
        }
    }

    pub fn encode(self) -> Vec<u8> {
        let mut buf = Vec::new();

        // field 1: sample_type (repeated ValueType)
        for vt in &self.value_types {
            let mut inner = Vec::new();
            vt.encode(&mut inner);
            encode_length_delimited(&mut buf, 1, &inner);
        }

        // field 2: sample (repeated Sample)
        for s in &self.samples {
            let mut inner = Vec::new();
            s.encode(&mut inner);
            encode_length_delimited(&mut buf, 2, &inner);
        }

        // field 4: location (repeated Location)
        for loc in &self.locations {
            let mut inner = Vec::new();
            loc.encode(&mut inner);
            encode_length_delimited(&mut buf, 4, &inner);
        }

        // field 5: function (repeated Function)
        for f in &self.functions {
            let mut inner = Vec::new();
            f.encode(&mut inner);
            encode_length_delimited(&mut buf, 5, &inner);
        }

        // field 6: string_table (repeated string)
        for s in &self.strings.strings {
            encode_string_field(&mut buf, 6, s);
        }

        // field 9: time_nanos
        encode_sint64_field(&mut buf, 9, self.time_nanos);

        // field 10: duration_nanos
        encode_sint64_field(&mut buf, 10, self.duration_nanos);

        // field 11: period_type (ValueType)
        {
            let mut inner = Vec::new();
            self.period_type.encode(&mut inner);
            encode_length_delimited(&mut buf, 11, &inner);
        }

        // field 12: period
        encode_sint64_field(&mut buf, 12, self.period);

        buf
    }
}

#[cfg(test)]
mod tests {
    use super::{Label, Sample};

    #[test]
    fn sample_encodes_string_labels_from_the_pprof_schema() {
        let sample = Sample {
            location_ids: vec![1],
            values: vec![1, 2],
            labels: vec![Label { key: 5, str: 6 }],
        };
        let mut bytes = Vec::new();
        sample.encode(&mut bytes);
        assert_eq!(
            bytes,
            vec![
                0x0a, 0x01, 0x01, 0x12, 0x02, 0x01, 0x02, 0x1a, 0x04, 0x08, 0x05, 0x10, 0x06
            ]
        );
    }
}
