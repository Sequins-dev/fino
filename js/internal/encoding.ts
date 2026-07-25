/**
* Internal UTF-8 byte helpers shared by runtime modules.
*
* These helpers are deliberately outside `js/globals/encoding.ts` because
* `encodeUtf8()` and `decodeUtf8()` are implementation primitives, not web
* standard globals. Public code should use `TextEncoder` and `TextDecoder`.
*
* @internal
*/
/**
* Encode a JS string to a Uint8Array of UTF-8 bytes.
*/
export function encodeUtf8(str: string): Uint8Array {
  let ascii = true;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    const buf = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
    return buf;
  }
  const buf = new Uint8Array(str.length * 4);
  let pos = 0;
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 55296 && cp <= 56319) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 56320 && lo <= 57343) {
        cp = 65536 + (cp - 55296 << 10) + (lo - 56320);
        i++;
      } else {
        cp = 65533;
      }
    } else if (cp >= 56320 && cp <= 57343) {
      cp = 65533;
    }
    if (cp < 128) {
      buf[pos++] = cp;
    } else if (cp < 2048) {
      buf[pos++] = 192 | cp >> 6;
      buf[pos++] = 128 | cp & 63;
    } else if (cp < 65536) {
      buf[pos++] = 224 | cp >> 12;
      buf[pos++] = 128 | cp >> 6 & 63;
      buf[pos++] = 128 | cp & 63;
    } else {
      buf[pos++] = 240 | cp >> 18;
      buf[pos++] = 128 | cp >> 12 & 63;
      buf[pos++] = 128 | cp >> 6 & 63;
      buf[pos++] = 128 | cp & 63;
    }
  }
  return buf.subarray(0, pos);
}
/**
* Decode UTF-8 bytes to a JS string.
*
* In fatal mode malformed sequences throw `TypeError`; otherwise malformed
* bytes are replaced with U+FFFD. When `skipBom` is true, an initial UTF-8 BOM
* is omitted.
*/
export function decodeUtf8(bytes: Uint8Array, fatal: boolean = false, skipBom: boolean = true): string {
  if (!fatal && skipBom) {
    let ascii = true;
    for (let k = 0; k < bytes.length; k++) {
      if (bytes[k]! >= 128) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      if (bytes.length <= 65536) return String.fromCharCode.apply(null, (bytes as unknown) as number[]);
      let out = '';
      for (let k = 0; k < bytes.length; k += 65536) {
        out += String.fromCharCode.apply(null, (bytes.subarray(k, k + 65536) as unknown) as number[]);
      }
      return out;
    }
  }
  let str = '';
  let i = 0;
  let first = true;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp: number;
    let seqLen: number;
    if (b0 < 128) {
      cp = b0;
      seqLen = 1;
    } else if ((b0 & 224) === 192) {
      cp = b0 & 31;
      seqLen = 2;
    } else if ((b0 & 240) === 224) {
      cp = b0 & 15;
      seqLen = 3;
    } else if ((b0 & 248) === 240) {
      cp = b0 & 7;
      seqLen = 4;
    } else {
      if (fatal) throw new TypeError(`TextDecoder: invalid byte 0x${b0.toString(16)} at index ${i}`);
      str += '�';
      i++;
      continue;
    }
    if (seqLen >= 3 && i + 1 < bytes.length) {
      const b1 = bytes[i + 1]!;
      const invalidSecond = (b1 & 192) === 128 && (b0 === 224 && b1 < 160 || b0 === 237 && b1 > 159 || b0 === 240 && b1 < 144 || b0 === 244 && b1 > 143);
      if (invalidSecond) {
        if (fatal) throw new TypeError(`TextDecoder: invalid byte 0x${b1.toString(16)} at index ${i + 1}`);
        str += '�';
        i++;
        continue;
      }
    }
    let valid = true;
    let missingContinuation = false;
    let invalidContinuationOffset = 1;
    for (let j = 1; j < seqLen; j++) {
      if (i + j >= bytes.length) {
        missingContinuation = true;
        valid = false;
        break;
      }
      if ((bytes[i + j]! & 192) !== 128) {
        invalidContinuationOffset = j;
        valid = false;
        break;
      }
      cp = cp << 6 | bytes[i + j]! & 63;
    }
    if (!valid) {
      if (fatal) throw new TypeError(`TextDecoder: incomplete sequence at index ${i}`);
      str += '�';
      i += missingContinuation ? bytes.length - i : invalidContinuationOffset;
      continue;
    }
    if (seqLen === 2 && cp < 128 || seqLen === 3 && cp < 2048 || seqLen === 4 && cp < 65536 || cp > 1114111 || cp >= 55296 && cp <= 57343) {
      if (fatal) throw new TypeError(`TextDecoder: invalid code point U+${cp.toString(16)} at index ${i}`);
      str += '�';
      i += seqLen;
      continue;
    }
    if (first && skipBom && cp === 65279) {
      i += seqLen;
      first = false;
      continue;
    }
    first = false;
    if (cp < 65536) {
      str += String.fromCharCode(cp);
    } else {
      cp -= 65536;
      str += String.fromCharCode(55296 + (cp >> 10), 56320 + (cp & 1023));
    }
    i += seqLen;
  }
  return str;
}
