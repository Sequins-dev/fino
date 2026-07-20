//! `internal:reactor-native` — the realm loop's native reactor bridge.
//!
//! The synthetic module routes a realm's asynchronous operations to its
//! hosting reactor engine: every JS thread (the process root included) runs
//! the same [`engine`] drive loop, so each op registers an owner-tagged
//! operation with the engine's shared [`io::RuntimeIo`] through the entered
//! workload's `ENGINE_CONTEXT`. Buffer retention, readiness, transfer, timer,
//! cancellation, and liveness bookkeeping live in [`io`].
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

/// Whether the drive loop must use a bounded re-pump instead of parking: an
/// Atomics.waitAsync resolution posts a V8 foreground task without waking the
/// reactor.
#[cfg(unix)]
pub(crate) fn drive_needs_poll() -> bool {
    imp::drive_needs_poll()
}
#[cfg(not(unix))]
pub(crate) fn drive_needs_poll() -> bool {
    false
}

// ===========================================================================
// Unix implementation (cherenkov: kqueue on macOS, io_uring on Linux)
// ===========================================================================
#[cfg(unix)]
mod imp {
    use std::ffi::c_void;
    use std::time::Duration;

    use ::v8;
    use cherenkov::fs_event;

    // kqueue NOTE_* values — the `{fflags}` vocabulary of the loop's vnode
    // callback contract on every platform (loop.ts dispatches these verbatim
    // and js/file/watch.ts branches on them), independent of the backend.
    const NOTE_DELETE: u32 = 0x1;
    const NOTE_WRITE: u32 = 0x2;
    const NOTE_ATTRIB: u32 = 0x8;
    const NOTE_RENAME: u32 = 0x20;

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
        engine_register_readiness(g, fd, crate::reactor::engine::IoKind::Readable);
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
        engine_register_readiness(g, fd, crate::reactor::engine::IoKind::Writable);
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
        // Register with the reactor engine: isolate-tagged, completed
        // off-isolate and resolved during the next pump. The buffer is
        // realm-provided; we retain it for liveness.
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
                // Register the remaining write with the reactor engine.
                let resolver_id = crate::async_rt::push_resolver(g_res);
                crate::reactor::engine::engine_io_register(crate::reactor::engine::EngineReg::Io(
                    crate::reactor::engine::PendingIoReg {
                        fd,
                        kind: crate::reactor::engine::IoKind::Write,
                        resolver_id,
                        buffer: Some(backing_store),
                        buf_ptr: ptr,
                        len,
                        written,
                    },
                ));
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
        let id = {
            let timer_id = crate::reactor::engine::engine_next_timer_id();
            let resolver_id = crate::async_rt::push_resolver(g);
            crate::reactor::engine::engine_io_register(crate::reactor::engine::EngineReg::Timer {
                timer_id,
                ms,
                resolver_id,
            });
            timer_id
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
        crate::reactor::engine::engine_io_register(
            crate::reactor::engine::EngineReg::CancelTimer { timer_id: id },
        );
    }

    pub fn set_timer_ref(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let id = args.get(0).integer_value(scope).unwrap_or(0).max(0) as u64;
        let referenced = args.get(1).boolean_value(scope);
        crate::reactor::engine::engine_io_register(
            crate::reactor::engine::EngineReg::SetTimerRef {
                timer_id: id,
                referenced,
            },
        );
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
        // An already-exited pid completes with a synthesized error on the next
        // harvest; delivery resolves on ANY completion, so the caller can
        // always proceed to reap.
        let resolver_id = crate::async_rt::push_resolver(g);
        crate::reactor::engine::engine_io_register(crate::reactor::engine::EngineReg::Proc {
            pid: pid.max(0) as u32,
            resolver_id,
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
        // Watch everything: watch.ts always subscribes ALL_NOTES, and the
        // requested-mask arg predates the portable event set.
        let callback_id = crate::async_rt::js_calls::register_callback(g);
        crate::reactor::engine::engine_io_register(crate::reactor::engine::EngineReg::AddVnode {
            fd,
            path,
            callback_id,
        });
    }

    pub fn remove_vnode(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        crate::reactor::engine::engine_io_register(
            crate::reactor::engine::EngineReg::RemoveVnode { fd },
        );
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
        // cherenkov installs a no-op handler (suppressing the default
        // disposition) and restores the previous sigaction on remove.
        let callback_id = crate::async_rt::js_calls::register_callback(g);
        crate::reactor::engine::engine_io_register(crate::reactor::engine::EngineReg::AddSignal {
            signo,
            callback_id,
        });
    }

    pub fn remove_signal(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let signo = arg_i32(scope, &args, 0);
        crate::reactor::engine::engine_io_register(
            crate::reactor::engine::EngineReg::RemoveSignal { signo },
        );
    }

    // --- wake sources & removal ------------------------------------------

    pub fn register_wake_source(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        // The isolate's async-runtime wake pipe needs no arming: the hosting
        // reactor claims the workload's wake sink (post_wake-tagged) right
        // after setup, so background FFI threads post straight into it.
        if fd == crate::async_rt::get_wake_read_fd() {
            return;
        }
        crate::reactor::engine::engine_io_register(crate::reactor::engine::EngineReg::WakeSource {
            fd,
        });
    }

    pub fn remove_read(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        crate::reactor::engine::engine_io_register(crate::reactor::engine::EngineReg::RemoveRead {
            fd,
        });
    }

    pub fn remove_write(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        crate::reactor::engine::engine_io_register(
            crate::reactor::engine::EngineReg::RemoveWrite { fd },
        );
    }

    // --- liveness & introspection ----------------------------------------

    pub fn alive(
        _scope: &mut v8::HandleScope,
        _args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        // A realm's io/timers/watches live in its hosting engine's op tables.
        rv.set_bool(crate::reactor::engine::engine_current_counts().total() > 0);
    }

    pub fn active_handle_counts(
        scope: &mut v8::HandleScope,
        _args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let engine = crate::reactor::engine::engine_current_counts();
        let obj = v8::Object::new(scope);
        for (name, val) in [
            ("reads", engine.reads as usize),
            ("writes", engine.writes as usize),
            ("timers", engine.timers as usize),
            ("procs", engine.procs as usize),
            ("vnodes", engine.vnodes as usize),
        ] {
            let k = v8::String::new(scope, name).unwrap();
            let v = num(scope, val as f64);
            obj.set(scope, k.into(), v);
        }
        rv.set(obj.into());
    }

    // --- atomics-waiter liveness ------------------------------------------

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
        let dispatched =
            crate::reactor::engine::engine_tick(scope, Some(Duration::from_millis(timeout_ms)));
        rv.set_int32(dispatched);
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
