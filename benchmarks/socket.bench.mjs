/**
 * Benchmarks for surge:socket (low-level syscall wrappers)
 *
 * Run with: cargo run -- --bench benchmarks/socket.bench.mjs
 *
 * These benchmarks cover the sync low-level operations (socket creation, address
 * encoding/decoding) without requiring a listening server.
 */

import {
  socket, close, encodeAddr, decodeAddr,
  AF_INET, AF_INET6, AF_UNIX, SOCK_STREAM, SOCK_DGRAM,
} from 'surge:socket';
import { bench } from 'surge:bench';

bench('socket() + close()', (b) => {
  b.group('by family', (g) => {
    g.measure('TCP IPv4',  () => { const fd = socket(AF_INET, SOCK_STREAM); close(fd); });
    g.measure('TCP IPv6',  () => { const fd = socket(AF_INET6, SOCK_STREAM); close(fd); });
    g.measure('UDP IPv4',  () => { const fd = socket(AF_INET, SOCK_DGRAM); close(fd); });
  });
});

bench('encodeAddr', (b) => {
  b.measure('IPv4 loopback',    () => encodeAddr({ family: 'ipv4', ip: '127.0.0.1', port: 8080 }));
  b.measure('IPv4 external',    () => encodeAddr({ family: 'ipv4', ip: '93.184.216.34', port: 443 }));
  b.measure('IPv6 loopback',    () => encodeAddr({ family: 'ipv6', ip: '::1', port: 8080 }));
  b.measure('IPv6 full',        () => encodeAddr({ family: 'ipv6', ip: '2001:db8::1', port: 443 }));
});

// Note: decodeAddr is omitted — it calls ArrayBuffer.slice() internally on each
// iteration, which triggers a Boa GC assertion under sustained allocation pressure.
// Track https://github.com/boa-dev/boa/issues for GC fixes.
