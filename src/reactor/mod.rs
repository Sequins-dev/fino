//! internal:reactor-native — native per-isolate event reactor.
//!
//! A single native reactor owns the platform completion backend (cherenkov:
//! kqueue on macOS, io_uring on Linux) and the promise resolvers for every
//! asynchronous operation an isolate is waiting on: fd readiness, fused
//! read/write transfers, timers, process-exit, vnode and signal watches, plus
//! persistent wake sources. It is the native equivalent of
//! `internal:runtime/loop` + `internal:runtime/kqueue` fused into one layer:
//! `tick()` performs the poll AND resolves the ready promises inline, so there
//! is no JS dispatch loop and no per-readiness Promise created on the JS side.
//!
//! It is exposed to JS as the synthetic module `internal:reactor-native` and is
//! wrapped by the `fino:net/loop-reactor` builtin, which presents the exact
//! `internal:runtime/loop` API surface. A realm swaps the reactor in by
//! remapping `internal:runtime/loop` to `fino:net/loop-reactor` via an
//! `ImportMap` override — see `research-docs/research/pure-rust-reactor.md`.
//!
//! The reactor is a per-thread `thread_local`, lazily created on first use, so
//! same-thread realms that do not opt in never allocate one. Embedded realms
//! share their thread's reactor: resolvers are per-context Globals, so the
//! shared `tick` dispatches each realm's completions into the right context.

use ::v8;

pub mod engine;

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
    Some(v8::undefined(scope).into())
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
    use cherenkov::{CURRENT_POS, Completion, Op, Source, WatchId, err, fs_event};

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

    /// What a reactor completion (keyed by `user_data`) resolves to.
    enum Pending {
        /// Bare readiness: resolve with the bytes-available hint.
        ReadReady {
            fd: i32,
            resolver: v8::Global<v8::PromiseResolver>,
        },
        /// Fused read: the backend performed the transfer; resolve the count.
        /// `buffer` keeps the realm's ArrayBuffer alive until harvest.
        ReadFused {
            fd: i32,
            resolver: v8::Global<v8::PromiseResolver>,
            buffer: v8::Global<v8::ArrayBuffer>,
            ptr: *mut u8,
            len: usize,
        },
        /// Bare write-readiness: resolve (value ignored).
        WriteReady {
            fd: i32,
            resolver: v8::Global<v8::PromiseResolver>,
        },
        /// Fused write of the remainder past the sync fast path; a partial
        /// completion resubmits until the whole buffer has drained
        /// (`writeAsync`'s contract is whole-buffer-or-error).
        WriteFused {
            fd: i32,
            resolver: v8::Global<v8::PromiseResolver>,
            buffer: v8::Global<v8::ArrayBuffer>,
            base: *mut u8,
            len: usize,
            written: usize,
        },
        Timer(v8::Global<v8::PromiseResolver>),
        Proc(v8::Global<v8::PromiseResolver>),
        /// The armed WatchNext of the fs watch adapting `vnodes[fd]`.
        VnodeNext { fd: i32 },
        /// The armed WatchNext of the signal watch adapting `signals[signo]`.
        SignalNext { signo: i32 },
        /// A persistent wake source: drain the fd and re-arm.
        WakeSource { fd: i32 },
        /// A canceled op awaiting harvest. The reactor contract keeps every
        /// submitted pointer alive until the completion (CANCELED included) is
        /// harvested, so the buffer Global rides along until then.
        Dead {
            _buffer: Option<v8::Global<v8::ArrayBuffer>>,
        },
    }

    struct VnodeEntry {
        watch: WatchId,
        cb: v8::Global<v8::Function>,
    }

    struct SignalEntry {
        watch: WatchId,
        cb: v8::Global<v8::Function>,
    }

    struct NativeReactor {
        reactor: cherenkov::Reactor,
        /// Monotonic op-tag source (bit 63 clear — see `POST_*`).
        next_ud: u64,
        ops: HashMap<u64, Pending>,
        /// One stream op per (fd, direction): fd → its op's user_data, so
        /// removeRead/removeWrite can find and cancel it.
        read_ud_by_fd: HashMap<i32, u64>,
        write_ud_by_fd: HashMap<i32, u64>,
        vnodes: HashMap<i32, VnodeEntry>,
        signals: HashMap<i32, SignalEntry>,
        timers: usize,
        procs: usize,
        scratch: Vec<Completion>,
    }

    impl NativeReactor {
        fn new() -> Self {
            let reactor = cherenkov::Reactor::new()
                .unwrap_or_else(|e| panic!("cherenkov::Reactor::new() failed: {e}"));
            NativeReactor {
                reactor,
                next_ud: 1,
                ops: HashMap::new(),
                read_ud_by_fd: HashMap::new(),
                write_ud_by_fd: HashMap::new(),
                vnodes: HashMap::new(),
                signals: HashMap::new(),
                timers: 0,
                procs: 0,
                scratch: Vec::new(),
            }
        }

        fn alloc_ud(&mut self) -> u64 {
            let ud = self.next_ud;
            self.next_ud += 1;
            ud
        }

        fn live_handles(&self) -> usize {
            // Signals and wake sources are deliberately excluded — they must
            // not keep a realm alive (matching loop.ts's alive() accounting).
            self.read_ud_by_fd.len()
                + self.write_ud_by_fd.len()
                + self.timers
                + self.procs
                + self.vnodes.len()
        }
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

    /// Non-creating access: `alive`/`tick`/`activeHandleCounts` on a thread
    /// with no reactor (e.g. an engine tenant) must not instantiate one.
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
    fn fs_to_note(mask: i32) -> u32 {
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
    /// actually blocks does `buffer_global` retain the buffer across the await.
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

    /// Retain the backing ArrayBuffer as a `Global` — used only on the blocking
    /// path, so the GC cannot collect the buffer before the op completes on a
    /// later tick. The absolute offset is already known from `buffer_ptr`.
    fn buffer_global(
        scope: &mut v8::HandleScope,
        val: v8::Local<v8::Value>,
    ) -> Option<v8::Global<v8::ArrayBuffer>> {
        if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(val) {
            Some(v8::Global::new(scope, ab))
        } else if let Ok(ta) = v8::Local::<v8::TypedArray>::try_from(val) {
            let ab = ta.buffer(scope)?;
            Some(v8::Global::new(scope, ab))
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
        with_reactor(|r| {
            let ud = r.alloc_ud();
            r.reactor.submit_poll_in(ud, Source::fd(fd));
            r.ops.insert(ud, Pending::ReadReady { fd, resolver: g });
            r.read_ud_by_fd.insert(fd, ud);
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
        with_reactor(|r| {
            let ud = r.alloc_ud();
            r.reactor.submit_poll_out(ud, Source::fd(fd));
            r.ops.insert(ud, Pending::WriteReady { fd, resolver: g });
            r.write_ud_by_fd.insert(fd, ud);
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
        let g_ab = match buffer_global(scope, val) {
            Some(g) => g,
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
                    buffer: Some(g_ab),
                    buf_ptr: ptr,
                    len,
                    written: 0,
                },
            ));
            return;
        }
        with_reactor(|r| submit_fused_read(r, fd, g_res, g_ab, ptr, len));
    }

    /// Submit (or resubmit) the fused read op and index it by fd.
    fn submit_fused_read(
        r: &mut NativeReactor,
        fd: i32,
        resolver: v8::Global<v8::PromiseResolver>,
        buffer: v8::Global<v8::ArrayBuffer>,
        ptr: *mut u8,
        len: usize,
    ) {
        let ud = r.alloc_ud();
        // SAFETY: the ArrayBuffer is retained in the Pending record until this
        // op's completion is harvested, keeping `ptr` valid throughout.
        unsafe {
            r.reactor.submit(
                ud,
                Op::Read {
                    src: Source::fd(fd),
                    buf: ptr,
                    len: len as u32,
                    off: CURRENT_POS,
                },
            );
        }
        r.ops.insert(
            ud,
            Pending::ReadFused {
                fd,
                resolver,
                buffer,
                ptr,
                len,
            },
        );
        r.read_ud_by_fd.insert(fd, ud);
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
                let g_ab = match buffer_global(scope, val) {
                    Some(g) => g,
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
                                buffer: Some(g_ab),
                                buf_ptr: ptr,
                                len,
                                written,
                            },
                        ),
                    );
                    return;
                }
                with_reactor(|r| submit_fused_write(r, fd, g_res, g_ab, ptr, len, written));
            }
        }
    }

    /// Submit (or resubmit) the remaining `[written, len)` of a fused write.
    fn submit_fused_write(
        r: &mut NativeReactor,
        fd: i32,
        resolver: v8::Global<v8::PromiseResolver>,
        buffer: v8::Global<v8::ArrayBuffer>,
        base: *mut u8,
        len: usize,
        written: usize,
    ) {
        let ud = r.alloc_ud();
        // SAFETY: the ArrayBuffer is retained in the Pending record until this
        // op's completion is harvested, keeping `base` valid throughout.
        unsafe {
            r.reactor.submit(
                ud,
                Op::Write {
                    src: Source::fd(fd),
                    buf: base.add(written) as *const u8,
                    len: (len - written) as u32,
                    off: CURRENT_POS,
                },
            );
        }
        r.ops.insert(
            ud,
            Pending::WriteFused {
                fd,
                resolver,
                buffer,
                base,
                len,
                written,
            },
        );
        r.write_ud_by_fd.insert(fd, ud);
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
            with_reactor(|r| {
                let ud = r.alloc_ud();
                r.reactor.submit_timeout(ud, ms as u64);
                r.ops.insert(ud, Pending::Timer(g));
                r.timers += 1;
                ud
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
        with_reactor(|r| {
            // Timer records carry no pointers, so eager removal is safe; the
            // CANCELED completion finds no record and is ignored.
            if matches!(r.ops.get(&id), Some(Pending::Timer(_))) {
                r.reactor.cancel(id);
                r.ops.remove(&id);
                r.timers -= 1;
            }
        });
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
        with_reactor(|r| {
            let ud = r.alloc_ud();
            // An already-exited pid completes with a synthesized error on the
            // next tick; dispatch resolves on ANY completion, so the caller can
            // always proceed to reap.
            r.reactor.submit_proc_exit(ud, pid.max(0) as u32);
            r.ops.insert(ud, Pending::Proc(g));
            r.procs += 1;
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
        with_reactor(|r| {
            if let Some(old) = r.vnodes.remove(&fd) {
                let _ = r.reactor.remove_watch(old.watch);
            }
            // Watch everything: watch.ts always subscribes ALL_NOTES, and the
            // requested-mask arg predates the portable event set.
            if let Ok(watch) = r.reactor.add_fs_watch(&path, fs_event::ALL) {
                let ud = r.alloc_ud();
                r.reactor.submit_watch_next(ud, watch);
                r.ops.insert(ud, Pending::VnodeNext { fd });
                r.vnodes.insert(fd, VnodeEntry { watch, cb: g });
            }
        });
    }

    pub fn remove_vnode(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        with_reactor(|r| {
            if let Some(entry) = r.vnodes.remove(&fd) {
                // The armed WatchNext completes CANCELED; dispatch drops it.
                let _ = r.reactor.remove_watch(entry.watch);
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
        with_reactor(|r| {
            if let Some(old) = r.signals.remove(&signo) {
                let _ = r.reactor.remove_watch(old.watch);
            }
            // cherenkov installs a no-op handler (suppressing the default
            // disposition) and restores the previous sigaction on remove.
            if let Ok(watch) = r.reactor.add_signal_watch(signo) {
                let ud = r.alloc_ud();
                r.reactor.submit_watch_next(ud, watch);
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
        with_reactor(|r| {
            if let Some(entry) = r.signals.remove(&signo) {
                let _ = r.reactor.remove_watch(entry.watch);
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
        with_reactor(|r| {
            let ud = r.alloc_ud();
            r.reactor.submit_poll_in(ud, Source::fd(fd));
            r.ops.insert(ud, Pending::WakeSource { fd });
        });
    }

    /// Cancel the outstanding op indexed by `fd`, retaining any buffer until
    /// its CANCELED completion is harvested. The promise stays unsettled
    /// forever — the documented loop contract for removal.
    fn cancel_indexed(r: &mut NativeReactor, ud: u64) {
        r.reactor.cancel(ud);
        let buffer = match r.ops.remove(&ud) {
            Some(Pending::ReadFused { buffer, .. }) | Some(Pending::WriteFused { buffer, .. }) => {
                Some(buffer)
            }
            _ => None,
        };
        r.ops.insert(ud, Pending::Dead { _buffer: buffer });
    }

    pub fn remove_read(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        with_reactor(|r| {
            if let Some(ud) = r.read_ud_by_fd.remove(&fd) {
                cancel_indexed(r, ud);
            }
        });
    }

    pub fn remove_write(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        with_reactor(|r| {
            if let Some(ud) = r.write_ud_by_fd.remove(&fd) {
                cancel_indexed(r, ud);
            }
        });
    }

    // --- liveness & introspection ----------------------------------------

    pub fn alive(
        _scope: &mut v8::HandleScope,
        _args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let live = with_reactor_opt(|r| r.live_handles() > 0).unwrap_or(false);
        rv.set_bool(live);
    }

    pub fn active_handle_counts(
        scope: &mut v8::HandleScope,
        _args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let (reads, writes, timers, procs, vnodes) = with_reactor_opt(|r| {
            (
                r.read_ud_by_fd.len(),
                r.write_ud_by_fd.len(),
                r.timers,
                r.procs,
                r.vnodes.len(),
            )
        })
        .unwrap_or((0, 0, 0, 0, 0));
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

    pub fn tick(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let timeout_ms = args.get(0).integer_value(scope).unwrap_or(0).max(0) as u64;
        // Non-creating: a thread with no reactor has nothing to wait for.
        let completions = with_reactor_opt(|r| {
            let mut buf = std::mem::take(&mut r.scratch);
            buf.clear();
            let _ = r
                .reactor
                .wait(Some(Duration::from_millis(timeout_ms)), &mut buf);
            buf
        });
        let Some(completions) = completions else {
            rv.set_int32(0);
            return;
        };
        // Dispatch OUTSIDE the RefCell borrow: resolvers run JS synchronously
        // (via microtask checkpoints later) and callbacks re-enter the reactor.
        let mut dispatched = 0i32;
        for c in &completions {
            dispatched += dispatch(scope, c.user_data, c.res);
        }
        with_reactor_opt(|r| r.scratch = completions);
        rv.set_int32(dispatched);
    }

    /// Route one completion. Returns 1 when it settled/notified something.
    fn dispatch(scope: &mut v8::HandleScope, ud: u64, res: i32) -> i32 {
        if ud == POST_FFI_WAKE {
            // The wake's only job was to break the sleep; the pump's drain
            // empties the FFI completion queues.
            return 1;
        }
        let pending = match with_reactor_opt(|r| r.ops.remove(&ud)).flatten() {
            Some(p) => p,
            None => return 0,
        };
        match pending {
            Pending::ReadReady { fd, resolver } => {
                unindex(fd, ud, true);
                resolve_num(scope, &resolver, if res > 0 { res as f64 } else { 0.0 });
                1
            }
            Pending::WriteReady { fd, resolver } => {
                unindex(fd, ud, false);
                resolve_undef(scope, &resolver);
                1
            }
            Pending::ReadFused {
                fd,
                resolver,
                buffer,
                ptr,
                len,
            } => {
                if res == -libc::EAGAIN {
                    // Spurious readiness — re-arm the same read.
                    with_reactor(|r| submit_fused_read(r, fd, resolver, buffer, ptr, len));
                    return 0;
                }
                unindex(fd, ud, true);
                resolve_num(scope, &resolver, res as f64);
                1
            }
            Pending::WriteFused {
                fd,
                resolver,
                buffer,
                base,
                len,
                written,
            } => {
                if res == -libc::EAGAIN {
                    with_reactor(|r| {
                        submit_fused_write(r, fd, resolver, buffer, base, len, written)
                    });
                    return 0;
                }
                if res < 0 {
                    unindex(fd, ud, false);
                    resolve_num(scope, &resolver, res as f64);
                    return 1;
                }
                let new_written = written + res as usize;
                if new_written >= len {
                    unindex(fd, ud, false);
                    resolve_num(scope, &resolver, new_written as f64);
                    1
                } else {
                    // Partial write: keep draining the remainder.
                    with_reactor(|r| {
                        submit_fused_write(r, fd, resolver, buffer, base, len, new_written)
                    });
                    0
                }
            }
            Pending::Timer(g) => {
                with_reactor(|r| r.timers -= 1);
                resolve_undef(scope, &g);
                1
            }
            Pending::Proc(g) => {
                // Any completion — including "already exited / not visible"
                // errors — means the caller can proceed to reap.
                with_reactor(|r| r.procs -= 1);
                resolve_undef(scope, &g);
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
                        let ud = r.alloc_ud();
                        r.reactor.submit_poll_in(ud, Source::fd(fd));
                        r.ops.insert(ud, Pending::WakeSource { fd });
                    });
                }
                1
            }
            Pending::Dead { _buffer } => 0,
        }
    }

    /// Drop the fd index entry, but only if it still points at this op (a
    /// BUSY-rejected duplicate must not unhook the live op's index).
    fn unindex(fd: i32, ud: u64, read: bool) {
        with_reactor(|r| {
            let map = if read {
                &mut r.read_ud_by_fd
            } else {
                &mut r.write_ud_by_fd
            };
            if map.get(&fd) == Some(&ud) {
                map.remove(&fd);
            }
        });
    }

    fn dispatch_vnode(scope: &mut v8::HandleScope, fd: i32, res: i32) -> i32 {
        if res == err::CANCELED || res == err::BUSY {
            return 0;
        }
        if res < 0 {
            // Kernel tore the watch down (-ENODEV) or it vanished (-ENOENT).
            with_reactor(|r| {
                if let Some(entry) = r.vnodes.remove(&fd) {
                    let _ = r.reactor.remove_watch(entry.watch);
                }
            });
            return 0;
        }
        let cb = with_reactor(|r| r.vnodes.get(&fd).map(|e| e.cb.clone()));
        let Some(g) = cb else { return 0 };
        let func = v8::Local::new(scope, &g);
        let recv = v8::undefined(scope).into();
        let arg = v8::Object::new(scope);
        let k = v8::String::new(scope, "fflags").unwrap();
        let v = num(scope, fs_to_note(res) as f64);
        arg.set(scope, k.into(), v);
        func.call(scope, recv, &[arg.into()]);
        // Re-arm only if the entry survived the callback (which may have
        // called removeVnode synchronously — watch.ts's delete handler does).
        with_reactor(|r| {
            if let Some(watch) = r.vnodes.get(&fd).map(|e| e.watch) {
                let ud = r.alloc_ud();
                r.reactor.submit_watch_next(ud, watch);
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
                        let _ = r.reactor.remove_watch(entry.watch);
                    }
                });
            }
            return 0;
        }
        let cb = with_reactor(|r| r.signals.get(&signo).map(|e| e.cb.clone()));
        let Some(g) = cb else { return 0 };
        // One callback per completion, however many deliveries coalesced —
        // matching kqueue EV_CLEAR semantics the JS contract was built on.
        let func = v8::Local::new(scope, &g);
        let recv = v8::undefined(scope).into();
        func.call(scope, recv, &[]);
        with_reactor(|r| {
            if let Some(watch) = r.signals.get(&signo).map(|e| e.watch) {
                let ud = r.alloc_ud();
                r.reactor.submit_watch_next(ud, watch);
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
}
