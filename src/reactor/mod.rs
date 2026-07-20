//! `internal:reactor-native` — the realm loop's native reactor bridge.
//!
//! The synthetic module routes a realm's asynchronous operations to the one
//! Cherenkov completion reactor owned by its thread. Reactor-engine workloads
//! register owner-tagged operations directly with [`io::RuntimeIo`]; the host
//! loop uses a small adapter that stores V8 globals while its isolate is
//! entered. Both paths share buffer retention, readiness, transfer, timer,
//! cancellation, and liveness bookkeeping in [`io`].
//!
//! It is exposed to JS as the synthetic module `internal:reactor-native` and is
//! wrapped by the `internal:runtime/loop` builtin, which presents the runtime
//! loop API surface. The loader provides that implementation to every realm.

use ::v8;

pub mod engine;
mod io;
pub(crate) mod workload;

/// Build the `internal:reactor-native` synthetic module.
pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let names = [
        "readable",
        "writable",
        "readAsync",
        "writeAsync",
        "fileRead",
        "addTimer",
        "cancelTimer",
        "setTimerRef",
        "tick",
        "alive",
        "registerWakeSource",
        "removeRead",
        "removeWrite",
        "proc",
        "addVnode",
        "removeVnode",
        "addSignal",
        "removeSignal",
        "activeHandleCounts",
        "trackAtomicsWaiter",
        "untrackAtomicsWaiter",
        "setNonblocking",
        "openSync",
    ];
    let export_names: Vec<v8::Local<v8::String>> = names
        .iter()
        .map(|n| v8::String::new(scope, n).unwrap())
        .collect();
    let module_name = v8::String::new(scope, "internal:reactor-native").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };
    macro_rules! export {
        ($name:literal, $cb:path) => {{
            let tmpl = v8::FunctionTemplate::new(scope, $cb);
            let func = tmpl.get_function(scope)?;
            let key = v8::String::new(scope, $name)?;
            module.set_synthetic_module_export(scope, key, func.into())?;
        }};
    }
    export!("readable", imp::readable);
    export!("writable", imp::writable);
    export!("readAsync", imp::read_async);
    export!("writeAsync", imp::write_async);
    export!("fileRead", imp::file_read);
    export!("addTimer", imp::add_timer);
    export!("cancelTimer", imp::cancel_timer);
    export!("setTimerRef", imp::set_timer_ref);
    export!("tick", imp::tick);
    export!("alive", imp::alive);
    export!("registerWakeSource", imp::register_wake_source);
    export!("removeRead", imp::remove_read);
    export!("removeWrite", imp::remove_write);
    export!("proc", imp::proc);
    export!("addVnode", imp::add_vnode);
    export!("removeVnode", imp::remove_vnode);
    export!("addSignal", imp::add_signal);
    export!("removeSignal", imp::remove_signal);
    export!("activeHandleCounts", imp::active_handle_counts);
    export!("trackAtomicsWaiter", imp::track_atomics_waiter);
    export!("untrackAtomicsWaiter", imp::untrack_atomics_waiter);
    export!("setNonblocking", imp::set_nonblocking);
    export!("openSync", imp::open_sync);
    Some(v8::undefined(scope).into())
}

/// Whether the given realm (FinoState pointer identity) has reactor work
/// that must keep it alive (its live handles + atomics waiters). Non-creating.
#[cfg(unix)]
pub(crate) fn drive_live(owner: usize) -> bool {
    imp::drive_live(owner)
}
#[cfg(not(unix))]
pub(crate) fn drive_live(_owner: usize) -> bool {
    false
}

/// Debug string of the given realm's live-handle counters (FINO_LOOP_DEBUG).
#[cfg(unix)]
pub(crate) fn drive_counts_debug(owner: usize) -> String {
    imp::drive_counts_debug(owner)
}
#[cfg(not(unix))]
pub(crate) fn drive_counts_debug(_owner: usize) -> String {
    String::new()
}

/// Whether the native host loop must use a bounded wait instead of blocking.
#[cfg(unix)]
pub(crate) fn drive_needs_poll() -> bool {
    imp::drive_needs_poll()
}
#[cfg(not(unix))]
pub(crate) fn drive_needs_poll() -> bool {
    false
}

/// Wait on this thread's reactor and dispatch completions; see
/// `imp::wait_and_dispatch`.
#[cfg(unix)]
pub(crate) fn drive_wait_and_dispatch(
    scope: &mut v8::HandleScope,
    timeout: Option<std::time::Duration>,
) -> i32 {
    imp::wait_and_dispatch(scope, timeout)
}
#[cfg(not(unix))]
pub(crate) fn drive_wait_and_dispatch(
    _scope: &mut v8::HandleScope,
    _timeout: Option<std::time::Duration>,
) -> i32 {
    0
}

// ===========================================================================
// Unix implementation (cherenkov: kqueue on macOS, io_uring on Linux)
// ===========================================================================
#[cfg(unix)]
mod imp {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::time::Duration;

    use ::v8;
    use cherenkov::{Completion, Op, Source, WatchId, err, fs_event};

    /// Notifier post tags live in a namespace disjoint from op tags: ops use a
    /// monotonic counter with bit 63 clear; posts set bit 63.
    pub(crate) const POST_FFI_WAKE: u64 = 1 << 63;

    // kqueue NOTE_* values — the `{fflags}` vocabulary of the loop's vnode
    // callback contract on every platform (loop.ts dispatches these verbatim
    // and js/file/watch.ts branches on them), independent of the backend.
    const NOTE_DELETE: u32 = 0x1;
    const NOTE_WRITE: u32 = 0x2;
    const NOTE_ATTRIB: u32 = 0x8;
    const NOTE_RENAME: u32 = 0x20;

    /// What a reactor completion (keyed by `user_data`) resolves to. Every
    /// alive-counting record carries its `owner` — the realm (`FinoState`
    /// pointer) that registered it — so each scheduled realm's liveness is
    /// independent.
    enum Pending {
        Proc {
            owner: usize,
            resolver: v8::Global<v8::PromiseResolver>,
        },
        /// The armed WatchNext of the fs watch adapting `vnodes[fd]`.
        VnodeNext { fd: i32 },
        /// The armed WatchNext of the signal watch adapting `signals[signo]`.
        SignalNext { signo: i32 },
        /// A persistent wake source: drain the fd and re-arm.
        WakeSource { fd: i32 },
    }

    struct VnodeEntry {
        owner: usize,
        watch: WatchId,
        cb: v8::Global<v8::Function>,
    }

    struct SignalEntry {
        watch: WatchId,
        cb: v8::Global<v8::Function>,
    }

    /// Per-realm live-handle counts. Signals and wake sources are deliberately
    /// excluded — they must not keep a realm alive (matching loop.ts).
    #[derive(Default, Clone, Copy)]
    struct HandleCounts {
        procs: usize,
        vnodes: usize,
    }

    impl HandleCounts {
        fn total(&self) -> usize {
            self.procs + self.vnodes
        }
    }

    struct NativeReactor {
        io: crate::reactor::io::RuntimeIo,
        ops: HashMap<u64, Pending>,
        vnodes: HashMap<i32, VnodeEntry>,
        signals: HashMap<i32, SignalEntry>,
        /// Live-handle counts per owning realm (FinoState pointer identity).
        alive_by_owner: HashMap<usize, HandleCounts>,
        scratch: Vec<Completion>,
    }

    impl NativeReactor {
        fn new() -> Self {
            let io = crate::reactor::io::RuntimeIo::create()
                .unwrap_or_else(|e| panic!("cherenkov::Reactor::new() failed: {e}"));
            NativeReactor {
                io,
                ops: HashMap::new(),
                vnodes: HashMap::new(),
                signals: HashMap::new(),
                alive_by_owner: HashMap::new(),
                scratch: Vec::new(),
            }
        }

        fn bump(&mut self, owner: usize, f: impl FnOnce(&mut HandleCounts)) {
            let counts = self.alive_by_owner.entry(owner).or_default();
            f(counts);
            if counts.total() == 0 {
                self.alive_by_owner.remove(&owner);
            }
        }

        fn counts_for(&self, owner: usize) -> HandleCounts {
            self.alive_by_owner.get(&owner).copied().unwrap_or_default()
        }
    }

    /// The current realm's identity: the FinoState allocation address. Stable
    /// for a realm's lifetime; used to key per-realm handle accounting.
    fn owner_of(scope: &mut v8::HandleScope) -> usize {
        std::rc::Rc::as_ptr(&crate::state::get_state(scope)) as usize
    }

    thread_local! {
        // NOTE: dropped at thread exit in an unspecified order relative to the
        // isolate's teardown — the same hazard the previous inline-kqueue
        // thread_local had. The Globals inside are leaked, not dereferenced,
        // if the isolate dies first.
        static REACTOR: RefCell<Option<NativeReactor>> = const { RefCell::new(None) };
    }

    fn with_reactor<R>(f: impl FnOnce(&mut NativeReactor) -> R) -> R {
        REACTOR.with(|cell| {
            let mut slot = cell.borrow_mut();
            if slot.is_none() {
                *slot = Some(NativeReactor::new());
            }
            f(slot.as_mut().unwrap())
        })
    }

    /// Non-creating access: engine workloads already use the engine's reactor,
    /// so `alive`/`tick`/`activeHandleCounts` must not instantiate a second one.
    fn with_reactor_opt<R>(f: impl FnOnce(&mut NativeReactor) -> R) -> Option<R> {
        REACTOR.with(|cell| cell.borrow_mut().as_mut().map(f))
    }

    fn errno() -> i32 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
    }

    fn is_would_block(err: i32) -> bool {
        err == libc::EAGAIN || err == libc::EWOULDBLOCK
    }

    /// Recover the filesystem path behind an open fd, for adapting the loop's
    /// fd-based vnode contract onto cherenkov's path-based fs watches.
    fn fd_path(fd: i32) -> Option<std::path::PathBuf> {
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::ffi::OsStrExt;
            let mut buf = [0u8; libc::PATH_MAX as usize];
            if unsafe { libc::fcntl(fd, libc::F_GETPATH, buf.as_mut_ptr()) } < 0 {
                return None;
            }
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            Some(std::path::PathBuf::from(std::ffi::OsStr::from_bytes(
                &buf[..end],
            )))
        }
        #[cfg(not(target_os = "macos"))]
        {
            std::fs::read_link(format!("/proc/self/fd/{fd}")).ok()
        }
    }

    /// Translate a coalesced [`fs_event`] mask into the NOTE_* vocabulary the
    /// vnode callback contract expects. CREATE maps to NOTE_WRITE (kqueue
    /// reports directory-child churn as a write on the directory, and
    /// watch.ts rescans on it); OVERFLOW likewise — "something changed,
    /// rescan" is the correct recovery.
    pub(crate) fn fs_to_note(mask: i32) -> u32 {
        let mut out = 0u32;
        if mask & fs_event::MODIFY != 0 {
            out |= NOTE_WRITE;
        }
        if mask & fs_event::ATTRIB != 0 {
            out |= NOTE_ATTRIB;
        }
        if mask & fs_event::CREATE != 0 {
            out |= NOTE_WRITE;
        }
        if mask & fs_event::DELETE != 0 {
            out |= NOTE_DELETE;
        }
        if mask & fs_event::RENAME != 0 {
            out |= NOTE_RENAME;
        }
        if mask & fs_event::OVERFLOW != 0 {
            out |= NOTE_WRITE;
        }
        out
    }

    // --- v8 helpers -------------------------------------------------------

    fn arg_i32(scope: &mut v8::HandleScope, args: &v8::FunctionCallbackArguments, i: i32) -> i32 {
        args.get(i).int32_value(scope).unwrap_or(0)
    }

    fn arg_usize(
        scope: &mut v8::HandleScope,
        args: &v8::FunctionCallbackArguments,
        i: i32,
    ) -> usize {
        args.get(i).integer_value(scope).unwrap_or(0).max(0) as usize
    }

    /// Resolve a TypedArray/ArrayBuffer argument to a raw data pointer at the
    /// absolute offset (`view offset + extra`) plus that absolute offset. Returns
    /// a raw pointer (not a `Local`/`Global`) so the fast path allocates nothing:
    /// the pointer is valid for the duration of this synchronous callback because
    /// V8 ArrayBuffer backing stores are off-heap and do not move. Only when an op
    /// actually blocks does `buffer_backing_store` retain it across the await.
    fn buffer_ptr(
        scope: &mut v8::HandleScope,
        val: v8::Local<v8::Value>,
        extra: usize,
    ) -> Option<(*mut u8, usize)> {
        if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(val) {
            Some((ab_ptr(ab, extra), extra))
        } else if let Ok(ta) = v8::Local::<v8::TypedArray>::try_from(val) {
            let off = ta.byte_offset() + extra;
            let ab = ta.buffer(scope)?;
            Some((ab_ptr(ab, off), off))
        } else {
            None
        }
    }

    fn buffer_backing_store(
        scope: &mut v8::HandleScope,
        val: v8::Local<v8::Value>,
    ) -> Option<v8::SharedRef<v8::BackingStore>> {
        if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(val) {
            Some(ab.get_backing_store())
        } else if let Ok(ta) = v8::Local::<v8::TypedArray>::try_from(val) {
            Some(ta.buffer(scope)?.get_backing_store())
        } else {
            None
        }
    }

    fn ab_ptr(ab: v8::Local<v8::ArrayBuffer>, offset: usize) -> *mut u8 {
        let bs = ab.get_backing_store();
        match bs.data() {
            Some(p) => unsafe { (p.as_ptr() as *mut u8).add(offset) },
            None => std::ptr::null_mut(),
        }
    }

    fn num<'s>(scope: &mut v8::HandleScope<'s>, n: f64) -> v8::Local<'s, v8::Value> {
        v8::Number::new(scope, n).into()
    }

    fn resolve_num(scope: &mut v8::HandleScope, g: &v8::Global<v8::PromiseResolver>, n: f64) {
        let resolver = v8::Local::new(scope, g);
        let val = num(scope, n);
        resolver.resolve(scope, val);
    }

    fn resolve_undef(scope: &mut v8::HandleScope, g: &v8::Global<v8::PromiseResolver>) {
        let resolver = v8::Local::new(scope, g);
        let undef = v8::undefined(scope).into();
        resolver.resolve(scope, undef);
    }

    /// Create a fresh resolver, set its promise as the callback return value,
    /// and hand the caller the live resolver `Local` to settle synchronously.
    fn new_resolver<'s>(
        scope: &mut v8::HandleScope<'s>,
        rv: &mut v8::ReturnValue,
    ) -> v8::Local<'s, v8::PromiseResolver> {
        let resolver = v8::PromiseResolver::new(scope).unwrap();
        let promise = resolver.get_promise(scope);
        rv.set(promise.into());
        resolver
    }

    // --- readiness --------------------------------------------------------

    pub fn readable(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        let resolver = new_resolver(scope, &mut rv);
        let g = v8::Global::new(scope, resolver);
        if crate::reactor::engine::engine_io_active() {
            engine_register_readiness(g, fd, crate::reactor::engine::IoKind::Readable);
            return;
        }
        let owner = owner_of(scope);
        with_reactor(|r| {
            r.io.submit_readiness(
                crate::reactor::io::Owner::Host(owner),
                crate::reactor::io::Target::Host(g),
                fd,
                true,
            );
        });
    }

    /// Register a bare-readiness op (readable/writable) with the reactor engine.
    fn engine_register_readiness(
        g: v8::Global<v8::PromiseResolver>,
        fd: i32,
        kind: crate::reactor::engine::IoKind,
    ) {
        let resolver_id = crate::async_rt::push_resolver(g);
        crate::reactor::engine::engine_io_register(crate::reactor::engine::EngineReg::Io(
            crate::reactor::engine::PendingIoReg {
                fd,
                kind,
                resolver_id,
                buffer: None,
                buf_ptr: std::ptr::null_mut(),
                len: 0,
                written: 0,
            },
        ));
    }

    pub fn writable(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        let resolver = new_resolver(scope, &mut rv);
        let g = v8::Global::new(scope, resolver);
        if crate::reactor::engine::engine_io_active() {
            engine_register_readiness(g, fd, crate::reactor::engine::IoKind::Writable);
            return;
        }
        let owner = owner_of(scope);
        with_reactor(|r| {
            r.io.submit_readiness(
                crate::reactor::io::Owner::Host(owner),
                crate::reactor::io::Target::Host(g),
                fd,
                false,
            );
        });
    }

    // --- fused transfer ---------------------------------------------------

    pub fn read_async(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        let extra = arg_usize(scope, &args, 2);
        let len = arg_usize(scope, &args, 3);
        let val = args.get(1);
        let (ptr, _offset) = match buffer_ptr(scope, val, extra) {
            Some(v) => v,
            None => {
                let s = v8::String::new(scope, "readAsync: expected ArrayBuffer or TypedArray")
                    .unwrap();
                let exc = v8::Exception::type_error(scope, s);
                scope.throw_exception(exc);
                return;
            }
        };

        // Fast path: attempt the read immediately — data is often already buffered
        // on a keep-alive/pipelined connection. On success we return the byte count
        // SYNCHRONOUSLY (no Promise, no resolver, no Global): the caller awaits a
        // plain number. This mirrors loop.ts's `#avail` gate but avoids even the
        // readiness Promise. Only a genuine EAGAIN falls through to registration.
        let n = unsafe { libc::read(fd, ptr as *mut c_void, len) };
        if n >= 0 {
            rv.set(num(scope, n as f64));
            return;
        }
        let err = errno();
        if !is_would_block(err) {
            // Non-EAGAIN error: return -errno; FdReader treats <= 0 as EOF.
            rv.set(num(scope, -(err as f64)));
            return;
        }
        // Would block: allocate the resolver + retain the buffer, register interest.
        let resolver = new_resolver(scope, &mut rv);
        let g_res = v8::Global::new(scope, resolver);
        let backing_store = match buffer_backing_store(scope, val) {
            Some(store) => store,
            None => return,
        };
        // Engine mode: register with the reactor engine (isolate-tagged, completed
        // off-isolate and resolved during the next pump) rather than the inline
        // per-thread reactor. The buffer is realm-provided; we retain it for liveness.
        if crate::reactor::engine::engine_io_active() {
            let resolver_id = crate::async_rt::push_resolver(g_res);
            crate::reactor::engine::engine_io_register(crate::reactor::engine::EngineReg::Io(
                crate::reactor::engine::PendingIoReg {
                    fd,
                    kind: crate::reactor::engine::IoKind::Read,
                    resolver_id,
                    buffer: Some(backing_store),
                    buf_ptr: ptr,
                    len,
                    written: 0,
                },
            ));
            return;
        }
        let owner = owner_of(scope);
        with_reactor(|r| {
            r.io.submit_read(
                crate::reactor::io::Owner::Host(owner),
                crate::reactor::io::Target::Host(g_res),
                backing_store,
                fd,
                ptr,
                len,
            );
        });
    }

    pub fn write_async(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        let extra = arg_usize(scope, &args, 2);
        let len = arg_usize(scope, &args, 3);
        let val = args.get(1);
        let (ptr, _offset) = match buffer_ptr(scope, val, extra) {
            Some(v) => v,
            None => {
                let s = v8::String::new(scope, "writeAsync: expected ArrayBuffer or TypedArray")
                    .unwrap();
                let exc = v8::Exception::type_error(scope, s);
                scope.throw_exception(exc);
                return;
            }
        };

        // Fast path: drain as much as the socket buffer accepts right now. Small
        // HTTP responses usually complete here — returned SYNCHRONOUSLY as a byte
        // count (no Promise/resolver/Global). A partial write blocks and registers.
        match drain_write(fd, ptr, len, 0) {
            WriteStep::Done(total) => rv.set(num(scope, total as f64)),
            WriteStep::Error(e) => rv.set(num(scope, -(e as f64))),
            WriteStep::WouldBlock(written) => {
                let resolver = new_resolver(scope, &mut rv);
                let g_res = v8::Global::new(scope, resolver);
                let backing_store = match buffer_backing_store(scope, val) {
                    Some(store) => store,
                    None => return,
                };
                // Engine mode: register the remaining write with the reactor engine.
                if crate::reactor::engine::engine_io_active() {
                    let resolver_id = crate::async_rt::push_resolver(g_res);
                    crate::reactor::engine::engine_io_register(
                        crate::reactor::engine::EngineReg::Io(
                            crate::reactor::engine::PendingIoReg {
                                fd,
                                kind: crate::reactor::engine::IoKind::Write,
                                resolver_id,
                                buffer: Some(backing_store),
                                buf_ptr: ptr,
                                len,
                                written,
                            },
                        ),
                    );
                    return;
                }
                let owner = owner_of(scope);
                with_reactor(|r| {
                    r.io.submit_write(
                        crate::reactor::io::Owner::Host(owner),
                        crate::reactor::io::Target::Host(g_res),
                        backing_store,
                        fd,
                        ptr,
                        len,
                        written,
                    );
                });
            }
        }
    }

    enum WriteStep {
        Done(usize),
        WouldBlock(usize),
        Error(i32),
    }

    /// Drain `[base+written, base+len)` to `fd` with `write(2)`, advancing across
    /// partial writes. `base` points at the buffer's absolute offset; the backing
    /// store is contiguous and stable, so `base.add(written)` stays valid.
    fn drain_write(fd: i32, base: *mut u8, len: usize, mut written: usize) -> WriteStep {
        while written < len {
            let ptr = unsafe { base.add(written) };
            let n = unsafe { libc::write(fd, ptr as *const c_void, len - written) };
            if n > 0 {
                written += n as usize;
                continue;
            }
            if n < 0 {
                let err = errno();
                if is_would_block(err) {
                    return WriteStep::WouldBlock(written);
                }
                return WriteStep::Error(err);
            }
            // n == 0: nothing accepted; wait for writability.
            return WriteStep::WouldBlock(written);
        }
        WriteStep::Done(written)
    }

    pub fn file_read(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        let extra = arg_usize(scope, &args, 2);
        let len = arg_usize(scope, &args, 3);
        let (ptr, _offset) = match buffer_ptr(scope, args.get(1), extra) {
            Some(v) => v,
            None => return,
        };
        let pos = args.get(4).integer_value(scope).unwrap_or(-1);
        let ptr = ptr as *mut c_void;
        let n = if pos < 0 {
            unsafe { libc::read(fd, ptr, len) }
        } else {
            unsafe { libc::pread(fd, ptr, len, pos as libc::off_t) }
        };
        if n >= 0 {
            rv.set(num(scope, n as f64));
        } else {
            rv.set(num(scope, -(errno() as f64)));
        }
    }

    // --- timers -----------------------------------------------------------

    pub fn add_timer(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let ms = args.get(0).integer_value(scope).unwrap_or(0).max(0);
        let resolver = v8::PromiseResolver::new(scope).unwrap();
        let promise = resolver.get_promise(scope);
        let g = v8::Global::new(scope, resolver);
        let id = if crate::reactor::engine::engine_io_active() {
            let timer_id = crate::reactor::engine::engine_next_timer_id();
            let resolver_id = crate::async_rt::push_resolver(g);
            crate::reactor::engine::engine_io_register(crate::reactor::engine::EngineReg::Timer {
                timer_id,
                ms,
                resolver_id,
            });
            timer_id
        } else {
            let owner = owner_of(scope);
            with_reactor(|r| {
                r.io.submit_host_timer(
                    crate::reactor::io::Owner::Host(owner),
                    crate::reactor::io::Target::Host(g),
                    ms as u64,
                )
            })
        };
        let out = v8::Object::new(scope);
        let k_id = v8::String::new(scope, "id").unwrap();
        let v_id = num(scope, id as f64);
        out.set(scope, k_id.into(), v_id);
        let k_p = v8::String::new(scope, "promise").unwrap();
        out.set(scope, k_p.into(), promise.into());
        rv.set(out.into());
    }

    pub fn cancel_timer(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let id = args.get(0).integer_value(scope).unwrap_or(0).max(0) as u64;
        if crate::reactor::engine::engine_io_active() {
            crate::reactor::engine::engine_io_register(
                crate::reactor::engine::EngineReg::CancelTimer { timer_id: id },
            );
            return;
        }
        with_reactor(|r| r.io.cancel_timer(id));
    }

    pub fn set_timer_ref(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let id = args.get(0).integer_value(scope).unwrap_or(0).max(0) as u64;
        let referenced = args.get(1).boolean_value(scope);
        if crate::reactor::engine::engine_io_active() {
            crate::reactor::engine::engine_io_register(
                crate::reactor::engine::EngineReg::SetTimerRef {
                    timer_id: id,
                    referenced,
                },
            );
            return;
        }
        with_reactor(|r| r.io.set_timer_ref(id, referenced));
    }

    // --- proc / vnode / signal -------------------------------------------

    pub fn proc(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let pid = arg_i32(scope, &args, 0);
        let resolver = new_resolver(scope, &mut rv);
        let g = v8::Global::new(scope, resolver);
        if crate::reactor::engine::engine_io_active() {
            let resolver_id = crate::async_rt::push_resolver(g);
            crate::reactor::engine::engine_io_register(crate::reactor::engine::EngineReg::Proc {
                pid: pid.max(0) as u32,
                resolver_id,
            });
            return;
        }
        let owner = owner_of(scope);
        with_reactor(|r| {
            let ud = r.io.next_external_id();
            // An already-exited pid completes with a synthesized error on the
            // next tick; dispatch resolves on ANY completion, so the caller can
            // always proceed to reap.
            r.io.submit_proc_exit(ud, pid.max(0) as u32);
            r.ops.insert(ud, Pending::Proc { owner, resolver: g });
            r.bump(owner, |c| c.procs += 1);
            if std::env::var_os("FINO_LOOP_DEBUG").is_some() {
                eprintln!("[reactor] proc({pid}) -> ud {ud}");
            }
        });
    }

    pub fn add_vnode(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        let cb = match v8::Local::<v8::Function>::try_from(args.get(2)) {
            Ok(f) => f,
            Err(_) => return,
        };
        // The loop contract is fd-based (watch.ts opens its own fd); cherenkov
        // watches paths and owns its own fd. Recover the path — a watch on a
        // just-unlinked fd fails silently, matching the old EV_ERROR skip.
        let path = match fd_path(fd) {
            Some(p) => p,
            None => return,
        };
        let g = v8::Global::new(scope, cb);
        if crate::reactor::engine::engine_io_active() {
            let callback_id = crate::async_rt::js_calls::register_callback(g);
            crate::reactor::engine::engine_io_register(
                crate::reactor::engine::EngineReg::AddVnode {
                    fd,
                    path,
                    callback_id,
                },
            );
            return;
        }
        let owner = owner_of(scope);
        with_reactor(|r| {
            if let Some(old) = r.vnodes.remove(&fd) {
                let _ = r.io.remove_kernel_watch(old.watch);
                r.bump(old.owner, |c| c.vnodes -= 1);
            }
            // Watch everything: watch.ts always subscribes ALL_NOTES, and the
            // requested-mask arg predates the portable event set.
            match r.io.add_fs_watch(&path, fs_event::ALL) {
                Err(e) => {
                    if std::env::var_os("FINO_LOOP_DEBUG").is_some() {
                        eprintln!("[reactor] addVnode fd {fd} path {path:?} failed: {e}");
                    }
                }
                Ok(watch) => {
                    let ud = r.io.next_external_id();
                    r.io.submit_watch_next(ud, watch);
                    r.ops.insert(ud, Pending::VnodeNext { fd });
                    r.vnodes.insert(
                        fd,
                        VnodeEntry {
                            owner,
                            watch,
                            cb: g,
                        },
                    );
                    r.bump(owner, |c| c.vnodes += 1);
                }
            }
        });
    }

    pub fn remove_vnode(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        if crate::reactor::engine::engine_io_active() {
            crate::reactor::engine::engine_io_register(
                crate::reactor::engine::EngineReg::RemoveVnode { fd },
            );
            return;
        }
        with_reactor(|r| {
            if let Some(entry) = r.vnodes.remove(&fd) {
                // The armed WatchNext completes CANCELED; dispatch drops it.
                let _ = r.io.remove_kernel_watch(entry.watch);
                r.bump(entry.owner, |c| c.vnodes -= 1);
            }
        });
    }

    pub fn add_signal(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let signo = arg_i32(scope, &args, 0);
        let cb = match v8::Local::<v8::Function>::try_from(args.get(1)) {
            Ok(f) => f,
            Err(_) => return,
        };
        let g = v8::Global::new(scope, cb);
        if crate::reactor::engine::engine_io_active() {
            let callback_id = crate::async_rt::js_calls::register_callback(g);
            crate::reactor::engine::engine_io_register(
                crate::reactor::engine::EngineReg::AddSignal { signo, callback_id },
            );
            return;
        }
        with_reactor(|r| {
            if let Some(old) = r.signals.remove(&signo) {
                let _ = r.io.remove_kernel_watch(old.watch);
            }
            // cherenkov installs a no-op handler (suppressing the default
            // disposition) and restores the previous sigaction on remove.
            if let Ok(watch) = r.io.add_signal_watch(signo) {
                let ud = r.io.next_external_id();
                r.io.submit_watch_next(ud, watch);
                r.ops.insert(ud, Pending::SignalNext { signo });
                r.signals.insert(signo, SignalEntry { watch, cb: g });
            }
        });
    }

    pub fn remove_signal(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let signo = arg_i32(scope, &args, 0);
        if crate::reactor::engine::engine_io_active() {
            crate::reactor::engine::engine_io_register(
                crate::reactor::engine::EngineReg::RemoveSignal { signo },
            );
            return;
        }
        with_reactor(|r| {
            if let Some(entry) = r.signals.remove(&signo) {
                let _ = r.io.remove_kernel_watch(entry.watch);
            }
        });
    }

    // --- wake sources & removal ------------------------------------------

    pub fn register_wake_source(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        // The isolate's async-runtime wake pipe upgrades to a Notifier post:
        // background FFI threads then post straight into this thread's reactor
        // instead of writing pipe bytes. If a reactor already claimed the sink
        // (the engine claims a tenant's before its bootstrap runs), there is
        // nothing to arm — and no reactor must be created on that thread.
        if fd == crate::async_rt::get_wake_read_fd() {
            if crate::async_rt::wake_notifier_installed() {
                return;
            }
            // On an engine thread the ENGINE claims the workload's sink right
            // after setup (post_wake-tagged); installing a notifier here
            // would win the first-install race with one from a stray
            // thread-local reactor nobody waits on.
            if crate::reactor::engine::engine_io_active() {
                return;
            }
            with_reactor(|r| {
                let notifier = r.io.notifier();
                crate::async_rt::install_wake_notifier(notifier, POST_FFI_WAKE);
            });
            return;
        }
        if crate::reactor::engine::engine_io_active() {
            crate::reactor::engine::engine_io_register(
                crate::reactor::engine::EngineReg::WakeSource { fd },
            );
            return;
        }
        with_reactor(|r| {
            let ud = r.io.next_external_id();
            r.io.submit_external(
                ud,
                Op::PollIn {
                    src: Source::fd(fd),
                },
            );
            r.ops.insert(ud, Pending::WakeSource { fd });
        });
    }

    pub fn remove_read(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        if crate::reactor::engine::engine_io_active() {
            crate::reactor::engine::engine_io_register(
                crate::reactor::engine::EngineReg::RemoveRead { fd },
            );
            return;
        }
        with_reactor(|r| r.io.remove_read(fd));
    }

    pub fn remove_write(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        if crate::reactor::engine::engine_io_active() {
            crate::reactor::engine::engine_io_register(
                crate::reactor::engine::EngineReg::RemoveWrite { fd },
            );
            return;
        }
        with_reactor(|r| r.io.remove_write(fd));
    }

    // --- liveness & introspection ----------------------------------------

    pub fn alive(
        _scope: &mut v8::HandleScope,
        _args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let owner = owner_of(_scope);
        let mut live = with_reactor_opt(|r| {
            r.counts_for(owner).total() > 0
                || r.io.counts(crate::reactor::io::Owner::Host(owner)).total() > 0
        })
        .unwrap_or(false);
        // An engine-hosted realm's io/timers live in the ENGINE's op table,
        // not this thread's reactor.
        if !live && crate::reactor::engine::engine_io_active() {
            live = crate::reactor::engine::engine_current_counts().total() > 0;
        }
        rv.set_bool(live);
    }

    pub fn active_handle_counts(
        scope: &mut v8::HandleScope,
        _args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let owner = owner_of(scope);
        let counts = with_reactor_opt(|r| r.counts_for(owner)).unwrap_or_default();
        let io_counts = with_reactor_opt(|r| r.io.counts(crate::reactor::io::Owner::Host(owner)))
            .unwrap_or_default();
        let (mut reads, mut writes, mut timers, mut procs, mut vnodes) = (
            io_counts.reads as usize,
            io_counts.writes as usize,
            io_counts.timers as usize,
            counts.procs,
            counts.vnodes,
        );
        if crate::reactor::engine::engine_io_active() {
            let engine = crate::reactor::engine::engine_current_counts();
            reads += engine.reads as usize;
            writes += engine.writes as usize;
            timers += engine.timers as usize;
            procs += engine.procs as usize;
            vnodes += engine.vnodes as usize;
        }
        let obj = v8::Object::new(scope);
        for (name, val) in [
            ("reads", reads),
            ("writes", writes),
            ("timers", timers),
            ("procs", procs),
            ("vnodes", vnodes),
        ] {
            let k = v8::String::new(scope, name).unwrap();
            let v = num(scope, val as f64);
            obj.set(scope, k.into(), v);
        }
        rv.set(obj.into());
    }

    // --- the poll+dispatch core ------------------------------------------

    /// Wait on the thread's reactor (up to `timeout`, `None` = block until
    /// something happens) and dispatch every harvested completion. Returns the
    /// dispatched count, or 0 when no reactor exists on this thread. Rust-side
    /// core of `tick()`, also driven directly by the native host loop.
    pub(crate) fn wait_and_dispatch(scope: &mut v8::HandleScope, timeout: Option<Duration>) -> i32 {
        // An engine-hosted realm's reactor IS the engine: harvest it in-pump,
        // dispatching this workload's completions inline.
        if crate::reactor::engine::engine_io_active() {
            return crate::reactor::engine::engine_tick(scope, timeout);
        }
        // Non-creating: a thread with no reactor has nothing to wait for.
        let completions = with_reactor_opt(|r| {
            let mut buf = std::mem::take(&mut r.scratch);
            buf.clear();
            let _ = r.io.wait(timeout, &mut buf);
            buf
        });
        let Some(completions) = completions else {
            return 0;
        };
        // Dispatch OUTSIDE the RefCell borrow: resolvers run JS synchronously
        // (via microtask checkpoints later) and callbacks re-enter the reactor.
        if std::env::var_os("FINO_LOOP_DEBUG").is_some() && !completions.is_empty() {
            thread_local! {
                static WAIT_TRACES: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
            }
            let n = WAIT_TRACES.with(|c| {
                let n = c.get();
                c.set(n + 1);
                n
            });
            if n < 500 || n.is_multiple_of(100_000) {
                let uds: Vec<String> = completions
                    .iter()
                    .map(|c| format!("{:#x}:{}", c.user_data, c.res))
                    .collect();
                eprintln!("[reactor] wait -> [{}] (n={n})", uds.join(","));
            }
        }
        let mut dispatched = 0i32;
        for c in &completions {
            dispatched += dispatch(scope, c.user_data, c.res);
        }
        with_reactor_opt(|r| r.scratch = completions);
        dispatched
    }

    /// Live-handle predicate for the native host loop: THIS REALM's reactor
    /// handles owned by this realm, plus Atomics.waitAsync waiters (which settle
    /// cross-thread with no reactor registration; thread-scoped).
    pub(crate) fn drive_live(owner: usize) -> bool {
        with_reactor_opt(|r| {
            r.counts_for(owner).total() > 0
                || r.io.counts(crate::reactor::io::Owner::Host(owner)).total() > 0
        })
        .unwrap_or(false)
            || ATOMICS_WAITERS.with(|c| c.get()) > 0
    }

    pub(crate) fn drive_counts_debug(owner: usize) -> String {
        let atomics = ATOMICS_WAITERS.with(|c| c.get());
        with_reactor_opt(|r| {
            let c = r.counts_for(owner);
            let io = r.io.counts(crate::reactor::io::Owner::Host(owner));
            let ops: Vec<String> = r
                .ops
                .iter()
                .map(|(ud, p)| {
                    let (kind, own, fd) = match p {
                        Pending::Proc { owner, .. } => ("p", *owner, -1),
                        Pending::VnodeNext { fd } => ("v", 0, *fd),
                        Pending::SignalNext { signo } => ("s", 0, *signo),
                        Pending::WakeSource { fd } => ("wk", 0, *fd),
                    };
                    format!(
                        "{ud}:{kind}:fd{fd}:{}",
                        if own == owner { "own" } else { "oth" }
                    )
                })
                .collect();
            format!(
                "r{}w{}t{}p{}v{}a{atomics} ops=[{}]",
                io.reads,
                io.writes,
                io.timers,
                c.procs,
                c.vnodes,
                ops.join(",")
            )
        })
        .unwrap_or_else(|| format!("none/a{atomics}"))
    }

    /// Whether the native host loop must poll instead of blocking: an
    /// Atomics.waitAsync resolution posts a V8 foreground task without waking
    /// the reactor, so it is only observed by a bounded re-pump.
    pub(crate) fn drive_needs_poll() -> bool {
        ATOMICS_WAITERS.with(|c| c.get()) > 0
    }

    thread_local! {
        static ATOMICS_WAITERS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    /// Variadic-safe `open(2)`: the mode argument rides the variadic ABI,
    /// which the JS FFI silently miscalls on ARM64 Darwin — files created
    /// through a fixed-arg FFI `open` get garbage permission bits. Returns
    /// the fd, or the negated errno on failure.
    pub fn open_sync(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let path = args.get(0).to_rust_string_lossy(scope);
        let flags = arg_i32(scope, &args, 1);
        let mode = args.get(2).integer_value(scope).unwrap_or(0).max(0) as libc::c_uint;
        let Ok(cpath) = std::ffi::CString::new(path) else {
            rv.set(num(scope, -(libc::EINVAL as f64)));
            return;
        };
        let fd = unsafe { libc::open(cpath.as_ptr(), flags, mode) };
        let res = if fd < 0 { -errno() } else { fd };
        rv.set(num(scope, res as f64));
    }

    /// Set an fd to non-blocking mode. A native loop primitive because the
    /// fused read/write fast paths REQUIRE non-blocking fds — and because
    /// `fcntl(2)` is variadic, which the JS FFI silently miscalls on ARM64
    /// Darwin (the third argument rides the variadic ABI): the JS-side
    /// `fcntl(F_SETFL, …)` helpers returned success while setting nothing.
    pub fn set_nonblocking(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags < 0 {
                let msg =
                    v8::String::new(scope, &format!("fcntl(F_GETFL) failed on fd {fd}")).unwrap();
                let exc = v8::Exception::error(scope, msg);
                scope.throw_exception(exc);
                return;
            }
            if libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                let msg =
                    v8::String::new(scope, &format!("fcntl(F_SETFL) failed on fd {fd}")).unwrap();
                let exc = v8::Exception::error(scope, msg);
                scope.throw_exception(exc);
            }
        }
    }

    pub fn track_atomics_waiter(
        _scope: &mut v8::HandleScope,
        _args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        ATOMICS_WAITERS.with(|c| c.set(c.get() + 1));
    }

    pub fn untrack_atomics_waiter(
        _scope: &mut v8::HandleScope,
        _args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        ATOMICS_WAITERS.with(|c| c.set(c.get().saturating_sub(1)));
    }

    pub fn tick(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let timeout_ms = args.get(0).integer_value(scope).unwrap_or(0).max(0) as u64;
        let dispatched = wait_and_dispatch(scope, Some(Duration::from_millis(timeout_ms)));
        rv.set_int32(dispatched);
    }

    /// Route one completion. Returns 1 when it settled/notified something.
    fn dispatch(scope: &mut v8::HandleScope, ud: u64, res: i32) -> i32 {
        if ud == POST_FFI_WAKE {
            // The wake's only job was to break the sleep; the pump's drain
            // empties the FFI completion queues.
            return 1;
        }
        match with_reactor(|r| r.io.dispatch(ud, res)) {
            crate::reactor::io::Dispatch::Resolved(resolved) => {
                let crate::reactor::io::Target::Host(resolver) = resolved.target else {
                    unreachable!("workload completion on host reactor")
                };
                resolve_num(scope, &resolver, resolved.result);
                return 1;
            }
            crate::reactor::io::Dispatch::Handled => return 0,
            crate::reactor::io::Dispatch::External => {}
        }
        let pending = match with_reactor_opt(|r| r.ops.remove(&ud)).flatten() {
            Some(p) => p,
            None => return 0,
        };
        match pending {
            Pending::Proc { owner, resolver } => {
                // Any completion — including "already exited / not visible"
                // errors — means the caller can proceed to reap.
                with_reactor(|r| r.bump(owner, |c| c.procs -= 1));
                if std::env::var_os("FINO_LOOP_DEBUG").is_some() {
                    eprintln!("[reactor] proc ud {ud} dispatched res={res}");
                }
                resolve_undef(scope, &resolver);
                1
            }
            Pending::VnodeNext { fd } => dispatch_vnode(scope, fd, res),
            Pending::SignalNext { signo } => dispatch_signal(scope, signo, res),
            Pending::WakeSource { fd } => {
                if res < 0 {
                    // Canceled or errored: drop the wake source.
                    return 0;
                }
                // Drain the pipe; EOF (write end closed) retires the source —
                // re-arming a drained-EOF fd would complete-readable forever.
                let mut buf = [0u8; 64];
                let eof = loop {
                    let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut c_void, buf.len()) };
                    if n == 0 {
                        break true;
                    }
                    if n < 0 {
                        break false;
                    }
                };
                if !eof {
                    with_reactor(|r| {
                        let ud = r.io.next_external_id();
                        r.io.submit_external(
                            ud,
                            Op::PollIn {
                                src: Source::fd(fd),
                            },
                        );
                        r.ops.insert(ud, Pending::WakeSource { fd });
                    });
                }
                1
            }
        }
    }

    fn dispatch_vnode(scope: &mut v8::HandleScope, fd: i32, res: i32) -> i32 {
        if res == err::CANCELED || res == err::BUSY {
            return 0;
        }
        if res < 0 {
            // Kernel tore the watch down (-ENODEV) or it vanished (-ENOENT).
            with_reactor(|r| {
                if let Some(entry) = r.vnodes.remove(&fd) {
                    let _ = r.io.remove_kernel_watch(entry.watch);
                    r.bump(entry.owner, |c| c.vnodes -= 1);
                }
            });
            return 0;
        }
        let cb = with_reactor(|r| r.vnodes.get(&fd).map(|e| e.cb.clone()));
        let Some(g) = cb else { return 0 };
        {
            let tc = &mut v8::TryCatch::new(scope);
            let func = v8::Local::new(tc, &g);
            let recv = v8::undefined(tc).into();
            let arg = v8::Object::new(tc);
            let k = v8::String::new(tc, "fflags").unwrap();
            let v = num(tc, fs_to_note(res) as f64);
            arg.set(tc, k.into(), v);
            // A throwing callback must not poison the rest of the dispatch
            // batch (a pending exception silently breaks later resolves).
            if func.call(tc, recv, &[arg.into()]).is_none() && tc.has_caught() {
                let msg = tc
                    .exception()
                    .map(|e| e.to_rust_string_lossy(tc))
                    .unwrap_or_else(|| "unknown exception".into());
                eprintln!("fino: vnode callback threw: {msg}");
            }
        }
        // Re-arm only if the entry survived the callback (which may have
        // called removeVnode synchronously — watch.ts's delete handler does).
        with_reactor(|r| {
            if let Some(watch) = r.vnodes.get(&fd).map(|e| e.watch) {
                let ud = r.io.next_external_id();
                r.io.submit_watch_next(ud, watch);
                r.ops.insert(ud, Pending::VnodeNext { fd });
            }
        });
        1
    }

    fn dispatch_signal(scope: &mut v8::HandleScope, signo: i32, res: i32) -> i32 {
        if res < 0 {
            if res != err::CANCELED && res != err::BUSY {
                with_reactor(|r| {
                    if let Some(entry) = r.signals.remove(&signo) {
                        let _ = r.io.remove_kernel_watch(entry.watch);
                    }
                });
            }
            return 0;
        }
        let cb = with_reactor(|r| r.signals.get(&signo).map(|e| e.cb.clone()));
        let Some(g) = cb else { return 0 };
        // One callback per completion, however many deliveries coalesced —
        // matching kqueue EV_CLEAR semantics the JS contract was built on.
        {
            let tc = &mut v8::TryCatch::new(scope);
            let func = v8::Local::new(tc, &g);
            let recv = v8::undefined(tc).into();
            if func.call(tc, recv, &[]).is_none() && tc.has_caught() {
                let msg = tc
                    .exception()
                    .map(|e| e.to_rust_string_lossy(tc))
                    .unwrap_or_else(|| "unknown exception".into());
                eprintln!("fino: signal callback threw: {msg}");
            }
        }
        with_reactor(|r| {
            if let Some(watch) = r.signals.get(&signo).map(|e| e.watch) {
                let ud = r.io.next_external_id();
                r.io.submit_watch_next(ud, watch);
                r.ops.insert(ud, Pending::SignalNext { signo });
            }
        });
        1
    }
}

// ===========================================================================
// Non-unix stub — cherenkov supports Windows, but the rest of the runtime
// (libc FFI throughout) does not yet; every entry point throws.
// ===========================================================================
#[cfg(not(unix))]
mod imp {
    use ::v8;

    fn unsupported(scope: &mut v8::HandleScope, mut rv: v8::ReturnValue) {
        let msg = v8::String::new(
            scope,
            "internal:reactor-native is not available on this platform",
        )
        .unwrap();
        let exc = v8::Exception::error(scope, msg);
        scope.throw_exception(exc);
        rv.set_undefined();
    }

    macro_rules! stub {
        ($name:ident) => {
            pub fn $name(
                scope: &mut v8::HandleScope,
                _args: v8::FunctionCallbackArguments,
                rv: v8::ReturnValue,
            ) {
                unsupported(scope, rv);
            }
        };
    }

    stub!(readable);
    stub!(writable);
    stub!(read_async);
    stub!(write_async);
    stub!(file_read);
    stub!(add_timer);
    stub!(cancel_timer);
    stub!(tick);
    stub!(alive);
    stub!(register_wake_source);
    stub!(remove_read);
    stub!(remove_write);
    stub!(proc);
    stub!(add_vnode);
    stub!(remove_vnode);
    stub!(add_signal);
    stub!(remove_signal);
    stub!(active_handle_counts);
    stub!(set_timer_ref);
    stub!(track_atomics_waiter);
    stub!(untrack_atomics_waiter);
    stub!(set_nonblocking);
    stub!(open_sync);
}
