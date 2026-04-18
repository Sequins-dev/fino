/**
 * Benchmarks for fino:encoding
 *
 * Run with: cargo run -- --bench benchmarks/encoding.bench.mjs
 */

import { encodeUtf8, decodeUtf8, TextEncoder, TextDecoder, btoa, atob, structuredClone } from 'fino:encoding';
import { bench } from 'fino:bench';

const SMALL_ASCII  = 'hello, world!!!';                     // 15 bytes
const KB_ASCII     = 'a'.repeat(1024);
const LARGE_ASCII  = 'a'.repeat(65536);
