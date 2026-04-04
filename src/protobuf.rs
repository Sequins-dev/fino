pub fn encode_varint(buf: &mut Vec<u8>, mut v: u64) {
    loop {
        let byte = (v & 0x7F) as u8;
        v >>= 7;
        if v == 0 {
            buf.push(byte);
            break;
        }
        buf.push(byte | 0x80);
    }
}

pub fn encode_varint_field(buf: &mut Vec<u8>, field: u32, value: u64) {
    if value == 0 {
        return;
    }
    buf.push((field << 3) as u8);
    encode_varint(buf, value);
}

pub fn encode_sint64_field(buf: &mut Vec<u8>, field: u32, value: i64) {
    encode_varint_field(buf, field, value as u64);
}

pub fn encode_length_delimited(buf: &mut Vec<u8>, field: u32, data: &[u8]) {
    if data.is_empty() {
        return;
    }
    buf.push(((field << 3) | 2) as u8);
    encode_varint(buf, data.len() as u64);
    buf.extend_from_slice(data);
}

pub fn encode_string_field(buf: &mut Vec<u8>, field: u32, s: &str) {
    buf.push(((field << 3) | 2) as u8);
    encode_varint(buf, s.len() as u64);
    buf.extend_from_slice(s.as_bytes());
}

pub fn encode_packed_u64(buf: &mut Vec<u8>, field: u32, values: &[u64]) {
    if values.is_empty() {
        return;
    }
    let mut inner = Vec::new();
    for &v in values {
        encode_varint(&mut inner, v);
    }
    encode_length_delimited(buf, field, &inner);
}

pub fn encode_packed_i64(buf: &mut Vec<u8>, field: u32, values: &[i64]) {
    if values.is_empty() {
        return;
    }
    let mut inner = Vec::new();
    for &v in values {
        encode_varint(&mut inner, v as u64);
    }
    encode_length_delimited(buf, field, &inner);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_round_trips_common_values() {
        let mut buf = Vec::new();
        encode_varint(&mut buf, 300);
        assert_eq!(buf, vec![0xac, 0x02]);
    }

    #[test]
    fn length_delimited_encodes_tag_len_and_bytes() {
        let mut buf = Vec::new();
        encode_length_delimited(&mut buf, 2, b"abc");
        assert_eq!(buf, vec![0x12, 0x03, b'a', b'b', b'c']);
    }

    #[test]
    fn packed_i64_encodes_as_delimited_sequence() {
        let mut buf = Vec::new();
        encode_packed_i64(&mut buf, 1, &[1, 2, 3]);
        assert_eq!(buf, vec![0x0a, 0x03, 0x01, 0x02, 0x03]);
    }
}
