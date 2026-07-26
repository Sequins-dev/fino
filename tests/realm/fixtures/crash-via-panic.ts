/**
 * Fixture: triggers a Rust-level panic via a deliberate OOM / hard error.
 *
 * We can't easily trigger a Rust panic from JS in normal operation.
 * This fixture instead causes the V8 isolate to run out of heap by
 * allocating large objects until V8 triggers a fatal error, which
 * `catch_unwind` in spawn_thread_realm will catch.
 *
 * NOTE: This file is intentionally NOT used in regular test suites.
 * The crash-detection path is tested via `tests/realm/crash.test.ts`
 * using a different mechanism.
 */
// This module intentionally left empty.
export {};
