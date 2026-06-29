//! Generic blocking-work offload pool.
//!
//! Wraps the `blocking` crate's auto-scaling thread pool so any Rust code can
//! offload synchronous work without coupling to a specific backend. The pool is
//! global (one per process), grows on demand up to `BLOCKING_MAX_THREADS`
//! (default 500, overridable via that env var), and shrinks when threads are
//! idle.
//!
//! # Why `blocking` instead of `std::thread::spawn`?
//! `std::thread::spawn` creates threads without limit. Under high concurrency
//! (many concurrent async FFI calls) this can exhaust OS thread limits and
//! cause `EAGAIN`. The `blocking` crate maintains a capped, reusable pool —
//! threads are parked when idle and reused for subsequent tasks, keeping
//! overhead low.
//!
//! # Configuring the cap
//! Set `BLOCKING_MAX_THREADS=<n>` in the environment before starting fino to
//! override the default cap. E.g., `BLOCKING_MAX_THREADS=32 fino script.ts`.

/// Submit a blocking closure to the shared thread pool (fire-and-forget).
///
/// The closure runs on one of the pool's background threads. There is no
/// way to await or cancel it after submission; callers use an out-of-band
/// completion mechanism (e.g., the async-FFI wake pipe and completions queue).
///
/// # Panics
/// If the closure panics, the panic is silently discarded (same as a detached
/// thread). Callers should handle errors within the closure itself.
pub fn spawn<F>(f: F)
where
    F: FnOnce() + Send + 'static,
{
    // `blocking::unblock` submits `f` to the pool and returns a Task<()>.
    // Detaching it drops the handle without awaiting, running f fire-and-forget.
    blocking::unblock(f).detach();
}
