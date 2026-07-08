//! internal:reactor-native — native per-isolate event reactor.
//!
//! A single native reactor owns the platform poller (kqueue on macOS) and the
//! promise resolvers for every asynchronous operation an isolate is waiting on:
//! fd readiness, fused read/write transfers, timers, process-exit, vnode and
//! signal watches, plus persistent wake sources. It is the native equivalent of
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
//! The reactor is a per-isolate `thread_local`, lazily created on first use, so
//! same-thread realms that do not opt in never allocate one.

use ::v8;

pub mod engine;
/// Raw io_uring ring backing the reactor on Linux (empty on other platforms via
/// its own `#![cfg(target_os = "linux")]`).
pub(crate) mod io_uring;
/// The reactor's completion-based poller: io_uring on Linux, a kqueue adapter on
/// macOS, behind one `Poller` alias with the same submit/wait contract.
pub(crate) mod poll;

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
        "loopFd",
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
    export!("loopFd", imp::loop_fd);
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
// macOS implementation (kqueue)
// ===========================================================================
#[cfg(target_os = "macos")]
mod imp {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};
    use std::ffi::c_void;

    use ::v8;

    const MAX_EVENTS: usize = 256;

    /// A pending read on an fd: either a bare readiness wait or a fused read
    /// that performs the `read(2)` in Rust and resolves with the byte count.
    enum PendingRead {
        Readiness(v8::Global<v8::PromiseResolver>),
        Fused {
            resolver: v8::Global<v8::PromiseResolver>,
            buffer: v8::Global<v8::ArrayBuffer>,
            offset: usize,
            len: usize,
        },
    }

    /// A pending write on an fd: bare writable wait or a fused write that drains
    /// the buffer in Rust across `EAGAIN`, resolving with the total bytes written.
    enum PendingWrite {
        Readiness(v8::Global<v8::PromiseResolver>),
        Fused {
            resolver: v8::Global<v8::PromiseResolver>,
            buffer: v8::Global<v8::ArrayBuffer>,
            offset: usize,
            len: usize,
            written: usize,
        },
    }

    struct Reactor {
        kq: i32,
        reads: HashMap<u64, PendingRead>,
        writes: HashMap<u64, PendingWrite>,
        timers: HashMap<u64, v8::Global<v8::PromiseResolver>>,
        procs: HashMap<u64, v8::Global<v8::PromiseResolver>>,
        vnodes: HashMap<u64, v8::Global<v8::Function>>,
        signals: HashMap<u64, v8::Global<v8::Function>>,
        wake_sources: HashSet<u64>,
        next_timer_id: u64,
        pending: Vec<libc::kevent>,
    }

    impl Reactor {
        fn new() -> Self {
            let kq = unsafe { libc::kqueue() };
            if kq < 0 {
                panic!("kqueue() failed: {}", std::io::Error::last_os_error());
            }
            Reactor {
                kq,
                reads: HashMap::new(),
                writes: HashMap::new(),
                timers: HashMap::new(),
                procs: HashMap::new(),
                vnodes: HashMap::new(),
                signals: HashMap::new(),
                wake_sources: HashSet::new(),
                next_timer_id: 1,
                pending: Vec::new(),
            }
        }

        fn queue(&mut self, ident: u64, filter: i16, flags: u16, fflags: u32, data: isize) {
            self.pending.push(libc::kevent {
                ident: ident as usize,
                filter,
                flags,
                fflags,
                data,
                udata: std::ptr::null_mut(),
            });
        }

        fn live_handles(&self) -> usize {
            self.reads.len()
                + self.writes.len()
                + self.timers.len()
                + self.procs.len()
                + self.vnodes.len()
        }
    }

    thread_local! {
        static REACTOR: RefCell<Option<Reactor>> = const { RefCell::new(None) };
    }

    fn with_reactor<R>(f: impl FnOnce(&mut Reactor) -> R) -> R {
        REACTOR.with(|cell| {
            let mut slot = cell.borrow_mut();
            if slot.is_none() {
                *slot = Some(Reactor::new());
            }
            f(slot.as_mut().unwrap())
        })
    }

    fn errno() -> i32 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
    }

    fn is_would_block(err: i32) -> bool {
        err == libc::EAGAIN || err == libc::EWOULDBLOCK
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
            r.reads.insert(fd as u64, PendingRead::Readiness(g));
            r.queue(
                fd as u64,
                libc::EVFILT_READ,
                libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
                0,
                0,
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
        with_reactor(|r| {
            r.writes.insert(fd as u64, PendingWrite::Readiness(g));
            r.queue(
                fd as u64,
                libc::EVFILT_WRITE,
                libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
                0,
                0,
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
        let (ptr, offset) = match buffer_ptr(scope, val, extra) {
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
        with_reactor(|r| {
            r.reads.insert(
                fd as u64,
                PendingRead::Fused {
                    resolver: g_res,
                    buffer: g_ab,
                    offset,
                    len,
                },
            );
            r.queue(
                fd as u64,
                libc::EVFILT_READ,
                libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
                0,
                0,
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
        let (ptr, offset) = match buffer_ptr(scope, val, extra) {
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
                with_reactor(|r| {
                    r.writes.insert(
                        fd as u64,
                        PendingWrite::Fused {
                            resolver: g_res,
                            buffer: g_ab,
                            offset,
                            len,
                            written,
                        },
                    );
                    r.queue(
                        fd as u64,
                        libc::EVFILT_WRITE,
                        libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
                        0,
                        0,
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
            with_reactor(|r| {
                let id = r.next_timer_id;
                r.next_timer_id += 1;
                r.timers.insert(id, g);
                r.queue(
                    id,
                    libc::EVFILT_TIMER,
                    libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
                    0,
                    ms as isize,
                );
                id
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
            if r.timers.remove(&id).is_some() {
                r.queue(id, libc::EVFILT_TIMER, libc::EV_DELETE, 0, 0);
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
        // Register synchronously so we can detect an already-exited process.
        let ev = libc::kevent {
            ident: pid as usize,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        let kq = with_reactor(|r| r.kq);
        let zero = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        let n = unsafe { libc::kevent(kq, &ev, 1, std::ptr::null_mut(), 0, &zero) };
        if n < 0 {
            // Process already exited — resolve immediately so the caller can reap.
            let undef = v8::undefined(scope).into();
            resolver.resolve(scope, undef);
            return;
        }
        let g = v8::Global::new(scope, resolver);
        with_reactor(|r| {
            r.procs.insert(pid as u64, g);
        });
    }

    pub fn add_vnode(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        let fflags = args.get(1).uint32_value(scope).unwrap_or(0);
        let cb = match v8::Local::<v8::Function>::try_from(args.get(2)) {
            Ok(f) => f,
            Err(_) => return,
        };
        let g = v8::Global::new(scope, cb);
        with_reactor(|r| {
            r.vnodes.insert(fd as u64, g);
            r.queue(
                fd as u64,
                libc::EVFILT_VNODE,
                libc::EV_ADD | libc::EV_ENABLE | libc::EV_CLEAR,
                fflags,
                0,
            );
        });
    }

    pub fn remove_vnode(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        with_reactor(|r| {
            if r.vnodes.remove(&(fd as u64)).is_some() {
                r.queue(fd as u64, libc::EVFILT_VNODE, libc::EV_DELETE, 0, 0);
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
        // Suppress default disposition so the process is not killed.
        unsafe { libc::signal(signo, libc::SIG_IGN) };
        let g = v8::Global::new(scope, cb);
        with_reactor(|r| {
            r.signals.insert(signo as u64, g);
            r.queue(
                signo as u64,
                libc::EVFILT_SIGNAL,
                libc::EV_ADD | libc::EV_ENABLE | libc::EV_CLEAR,
                0,
                0,
            );
        });
    }

    pub fn remove_signal(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let signo = arg_i32(scope, &args, 0);
        unsafe { libc::signal(signo, libc::SIG_DFL) };
        with_reactor(|r| {
            if r.signals.remove(&(signo as u64)).is_some() {
                r.queue(signo as u64, libc::EVFILT_SIGNAL, libc::EV_DELETE, 0, 0);
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
            r.wake_sources.insert(fd as u64);
            r.queue(
                fd as u64,
                libc::EVFILT_READ,
                libc::EV_ADD | libc::EV_ENABLE | libc::EV_CLEAR,
                0,
                0,
            );
        });
    }

    pub fn remove_read(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        with_reactor(|r| {
            r.reads.remove(&(fd as u64));
            r.queue(fd as u64, libc::EVFILT_READ, libc::EV_DELETE, 0, 0);
        });
    }

    pub fn remove_write(
        scope: &mut v8::HandleScope,
        args: v8::FunctionCallbackArguments,
        _rv: v8::ReturnValue,
    ) {
        let fd = arg_i32(scope, &args, 0);
        with_reactor(|r| {
            r.writes.remove(&(fd as u64));
            r.queue(fd as u64, libc::EVFILT_WRITE, libc::EV_DELETE, 0, 0);
        });
    }

    // --- liveness & introspection ----------------------------------------

    pub fn alive(
        _scope: &mut v8::HandleScope,
        _args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let live = with_reactor(|r| r.live_handles() > 0);
        rv.set_bool(live);
    }

    pub fn loop_fd(
        _scope: &mut v8::HandleScope,
        _args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let fd = with_reactor(|r| r.kq);
        rv.set_int32(fd);
    }

    pub fn active_handle_counts(
        scope: &mut v8::HandleScope,
        _args: v8::FunctionCallbackArguments,
        mut rv: v8::ReturnValue,
    ) {
        let (reads, writes, timers, procs, vnodes) = with_reactor(|r| {
            (
                r.reads.len(),
                r.writes.len(),
                r.timers.len(),
                r.procs.len(),
                r.vnodes.len(),
            )
        });
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
        let timeout_ms = args.get(0).integer_value(scope).unwrap_or(0).max(0);

        // Flush queued changes and block for events in a single kevent() call.
        // The event buffer is left uninitialized (kevent fills the first n slots);
        // avoiding an 8 KiB zero per tick.
        let mut evbuf = [const { std::mem::MaybeUninit::<libc::kevent>::uninit() }; MAX_EVENTS];
        let ts = libc::timespec {
            tv_sec: (timeout_ms / 1000) as libc::time_t,
            tv_nsec: ((timeout_ms % 1000) * 1_000_000) as libc::c_long,
        };
        let (kq, changes) = with_reactor(|r| (r.kq, std::mem::take(&mut r.pending)));
        let n = loop {
            let n = unsafe {
                libc::kevent(
                    kq,
                    changes.as_ptr(),
                    changes.len() as i32,
                    evbuf.as_mut_ptr().cast::<libc::kevent>(),
                    MAX_EVENTS as i32,
                    &ts,
                )
            };
            if n < 0 && errno() == libc::EINTR {
                continue;
            }
            break n;
        };
        if n < 0 {
            rv.set_int32(0);
            return;
        }

        let mut dispatched = 0i32;
        for slot in evbuf.iter().take(n as usize) {
            // SAFETY: kevent() initialized the first `n` slots.
            let ev = unsafe { slot.assume_init_ref() };
            // A failed changelist entry is reported as an event with EV_ERROR.
            if ev.flags & (libc::EV_ERROR) != 0 {
                continue;
            }
            dispatch(scope, ev);
            dispatched += 1;
        }
        rv.set_int32(dispatched);
    }

    fn dispatch(scope: &mut v8::HandleScope, ev: &libc::kevent) {
        let ident = ev.ident as u64;
        match ev.filter {
            libc::EVFILT_READ => dispatch_read(scope, ev, ident),
            libc::EVFILT_WRITE => dispatch_write(scope, ident),
            libc::EVFILT_TIMER => {
                if let Some(g) = with_reactor(|r| r.timers.remove(&ident)) {
                    resolve_undef(scope, &g);
                }
            }
            libc::EVFILT_PROC => {
                if let Some(g) = with_reactor(|r| r.procs.remove(&ident)) {
                    resolve_undef(scope, &g);
                }
            }
            libc::EVFILT_VNODE => {
                let cb = with_reactor(|r| r.vnodes.get(&ident).cloned());
                if let Some(g) = cb {
                    let func = v8::Local::new(scope, &g);
                    let recv = v8::undefined(scope).into();
                    let arg = v8::Object::new(scope);
                    let k = v8::String::new(scope, "fflags").unwrap();
                    let v = num(scope, ev.fflags as f64);
                    arg.set(scope, k.into(), v);
                    func.call(scope, recv, &[arg.into()]);
                }
            }
            libc::EVFILT_SIGNAL => {
                let cb = with_reactor(|r| r.signals.get(&ident).cloned());
                if let Some(g) = cb {
                    let func = v8::Local::new(scope, &g);
                    let recv = v8::undefined(scope).into();
                    func.call(scope, recv, &[]);
                }
            }
            _ => {}
        }
    }

    fn dispatch_read(scope: &mut v8::HandleScope, ev: &libc::kevent, ident: u64) {
        let pending = with_reactor(|r| r.reads.remove(&ident));
        let pending = match pending {
            Some(p) => p,
            None => {
                // Not an active read — maybe a persistent wake source. A closed
                // peer reports EV_EOF every tick forever; deregister to stop the spin.
                let is_wake = with_reactor(|r| r.wake_sources.contains(&ident));
                if is_wake && ev.flags & (libc::EV_EOF) != 0 {
                    with_reactor(|r| {
                        r.wake_sources.remove(&ident);
                        r.queue(ident, libc::EVFILT_READ, libc::EV_DELETE, 0, 0);
                    });
                }
                return;
            }
        };
        match pending {
            PendingRead::Readiness(g) => {
                let avail = if ev.data > 0 { ev.data as f64 } else { 0.0 };
                resolve_num(scope, &g, avail);
            }
            PendingRead::Fused {
                resolver,
                buffer,
                offset,
                len,
            } => {
                let ab = v8::Local::new(scope, &buffer);
                let n =
                    unsafe { libc::read(ev.ident as i32, ab_ptr(ab, offset) as *mut c_void, len) };
                if n >= 0 {
                    resolve_num(scope, &resolver, n as f64);
                } else {
                    let err = errno();
                    if is_would_block(err) {
                        // Spurious readiness — re-arm.
                        with_reactor(|r| {
                            r.reads.insert(
                                ident,
                                PendingRead::Fused {
                                    resolver,
                                    buffer,
                                    offset,
                                    len,
                                },
                            );
                            r.queue(
                                ident,
                                libc::EVFILT_READ,
                                libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
                                0,
                                0,
                            );
                        });
                    } else {
                        resolve_num(scope, &resolver, -(err as f64));
                    }
                }
            }
        }
    }

    fn dispatch_write(scope: &mut v8::HandleScope, ident: u64) {
        let pending = match with_reactor(|r| r.writes.remove(&ident)) {
            Some(p) => p,
            None => return,
        };
        match pending {
            PendingWrite::Readiness(g) => resolve_undef(scope, &g),
            PendingWrite::Fused {
                resolver,
                buffer,
                offset,
                len,
                written,
            } => {
                let ab = v8::Local::new(scope, &buffer);
                let base = ab_ptr(ab, offset);
                match drain_write(ident as i32, base, len, written) {
                    WriteStep::Done(total) => resolve_num(scope, &resolver, total as f64),
                    WriteStep::Error(e) => resolve_num(scope, &resolver, -(e as f64)),
                    WriteStep::WouldBlock(w) => {
                        with_reactor(|r| {
                            r.writes.insert(
                                ident,
                                PendingWrite::Fused {
                                    resolver,
                                    buffer,
                                    offset,
                                    len,
                                    written: w,
                                },
                            );
                            r.queue(
                                ident,
                                libc::EVFILT_WRITE,
                                libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
                                0,
                                0,
                            );
                        });
                    }
                }
            }
        }
    }
}

// ===========================================================================
// Non-macOS stub — the reactor requires an io_uring backend (not yet built),
// so every entry point throws. The default loop path is unaffected; only a
// realm that explicitly remaps onto the reactor would reach these.
// ===========================================================================
#[cfg(not(target_os = "macos"))]
mod imp {
    use ::v8;

    fn unsupported(scope: &mut v8::HandleScope, mut rv: v8::ReturnValue) {
        let msg = v8::String::new(
            scope,
            "internal:reactor-native is only available on macOS in this build",
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
    stub!(loop_fd);
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
