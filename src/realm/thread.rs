#![allow(dead_code)]
//! Thread Realm infrastructure.
//!
//! Spawns a separate OS thread with its own `v8::Isolate`, bootstrapping
//! `_bootstrap.mjs` and running a full host loop.  Bidirectional messaging
//! uses `mpsc` channels paired with POSIX wake pipes for kqueue/io_uring
//! integration: after each `channel_tx.send()` the sender writes 1 byte to
//! the receiver's wake pipe, which the receiver's event loop watches via
//! `EVFILT_READ` / `io_uring POLL`.
//!
//! ## Lifecycle
//!
//! 1. Parent calls `spawn_thread_realm(config)`.
//! 2. `spawn_thread_realm` creates two mpsc channel pairs and two wake pipes,
//!    packages everything into `IsolateConfig`, and spawns a thread that runs
//!    `run_thread_isolate`.
//! 3. The thread bootstraps its own `v8::Isolate`, evaluates `_bootstrap.mjs`
//!    (same as same-Isolate child realms), and runs its own host loop.
//! 4. When the thread's loop exits it returns `Ok(())` (or `Err(msg)` on error).
//! 5. The parent retains a `ThreadRealmHandle` with the send half of the
//!    channel and the child's wake-pipe write end for sending messages, plus
//!    the receive half and parent wake-pipe read end for receiving.

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    os::unix::io::RawFd,
    rc::Rc,
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}, mpsc},
};

use ::v8;

use crate::{
    loader,
    realm,
    state::{FinoState, ProviderConfig, get_state, root_queue_ptr},
};

/// Info shipped alongside a message for each transferred MessagePort.
///
/// The receiver uses `handle` to look up the Q-half transit channel and
/// `wake_read_fd` to register with the event loop via `loop.readable()`.
#[derive(Debug)]
pub struct TransferredPortInfo {
    pub handle: u32,
    pub wake_read_fd: i32,
}

/// A message transmitted across thread-realm boundaries.
///
/// `data` is the V8 ValueSerializer wire format for the message value.
/// `transfer_stores` holds raw bytes for each transferred ArrayBuffer.
/// `transfer_ports` carries transit channel info for each transferred
/// MessagePort so the receiver can reconstruct a live cross-thread port.
#[derive(Debug)]
pub struct ThreadMessage {
    pub data: Vec<u8>,
    pub transfer_stores: Vec<Vec<u8>>,
    pub transfer_ports: Vec<TransferredPortInfo>,
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Caller-supplied configuration for a new thread realm.
pub struct SpawnConfig {
    pub process_env: crate::state::ProcessEnv,
    pub entry_path: String,
    pub providers: HashMap<String, Option<ProviderConfig>>,
    pub package_map_json: Option<String>,
}

/// Returned to the parent after a thread realm is spawned.
///
/// The parent holds the send/receive ends for messaging the child and
/// registers `parent_wake_read` with its own event loop to detect inbound
/// messages.
pub struct ThreadRealmHandle {
    /// Send serialized messages to the child.
    pub tx: mpsc::Sender<ThreadMessage>,
    /// Write to wake the child after sending (1 byte is sufficient).
    pub child_wake_write: RawFd,
    /// Receive serialized messages from the child.
    pub rx: mpsc::Receiver<ThreadMessage>,
    /// Register with the parent's kqueue/io_uring to detect child messages.
    pub parent_wake_read: RawFd,
    /// Set to `true` by the child thread just before it exits (including panics).
    pub done: Arc<AtomicBool>,
    /// Error message if the thread exited due to an error or panic. `None` = clean exit.
    pub error: Arc<Mutex<Option<String>>>,
    /// Thread join handle — resolves when the child loop exits.
    pub join: std::thread::JoinHandle<()>,
}

impl Drop for ThreadRealmHandle {
    fn drop(&mut self) {
        // Close the fds this side owns: the write end toward the child and
        // the read end on the parent side.  The child closes its own fds
        // when `run_thread_isolate` returns (see `OwnedFd` wrapper below).
        unsafe {
            libc::close(self.child_wake_write);
            libc::close(self.parent_wake_read);
        }
    }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/// Configuration threaded through the OS thread boundary into
/// `run_thread_isolate`.
struct IsolateConfig {
    process_env: crate::state::ProcessEnv,
    entry_path: String,
    providers: HashMap<String, Option<ProviderConfig>>,
    package_map_json: Option<String>,
    /// Receives messages sent from the parent.
    channel_rx: mpsc::Receiver<ThreadMessage>,
    /// Sends messages to the parent.
    channel_tx: mpsc::Sender<ThreadMessage>,
    /// Own wake-pipe read end — register with child event loop.
    wake_read_fd: RawFd,
    /// Parent's wake-pipe write end — write here after each send.
    partner_wake_write_fd: RawFd,
}

/// RAII wrapper that closes a file descriptor on drop.
struct OwnedFd(RawFd);

impl Drop for OwnedFd {
    fn drop(&mut self) {
        if self.0 >= 0 {
            unsafe { libc::close(self.0) };
        }
    }
}

// ---------------------------------------------------------------------------
// Pipe creation
// ---------------------------------------------------------------------------

/// Create a non-blocking POSIX pipe. Returns `(read_fd, write_fd)`.
fn create_pipe() -> Result<(RawFd, RawFd), String> {
    let mut fds = [0i32; 2];
    // SAFETY: fds is a valid 2-element i32 array; pipe() is a standard call.
    let ret = unsafe { libc::pipe(fds.as_mut_ptr()) };
    if ret != 0 {
        return Err(format!(
            "pipe() failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // Set O_NONBLOCK so reads/writes never block the event loop.
    unsafe {
        libc::fcntl(fds[0], libc::F_SETFL, libc::O_NONBLOCK);
        libc::fcntl(fds[1], libc::F_SETFL, libc::O_NONBLOCK);
    }
    Ok((fds[0], fds[1]))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Spawn a new thread realm and return the parent-side handle.
///
/// Creates two mpsc channel pairs (parent→child, child→parent) and two
/// wake pipes (one per direction), then launches `run_thread_isolate` on a
/// new OS thread.
pub fn spawn_thread_realm(config: SpawnConfig) -> Result<ThreadRealmHandle, String> {
    let (parent_tx, child_rx) = mpsc::channel::<ThreadMessage>();
    let (child_tx, parent_rx) = mpsc::channel::<ThreadMessage>();

    let (child_wake_read, child_wake_write) = create_pipe()?;
    let (parent_wake_read, parent_wake_write) = create_pipe()?;

    let done_flag = Arc::new(AtomicBool::new(false));
    let done_for_thread = done_flag.clone();
    let error_flag: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let error_for_thread = error_flag.clone();

    let iso_config = IsolateConfig {
        process_env: config.process_env,
        entry_path: config.entry_path,
        providers: config.providers,
        package_map_json: config.package_map_json,
        channel_rx: child_rx,
        channel_tx: child_tx,
        wake_read_fd: child_wake_read,
        partner_wake_write_fd: parent_wake_write,
    };

    let join = std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_thread_isolate(iso_config)
        }));
        // Always set done so the parent's polling loop exits.
        done_for_thread.store(true, Ordering::Release);
        let msg = match result {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(e),
            Err(payload) => {
                let desc = payload
                    .downcast_ref::<String>()
                    .map(|s| s.to_owned())
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "thread realm panicked".to_string());
                Some(format!("thread realm panicked: {desc}"))
            }
        };
        if let Some(msg) = msg {
            *error_for_thread.lock().unwrap() = Some(msg);
        }
    });

    Ok(ThreadRealmHandle {
        tx: parent_tx,
        child_wake_write,
        rx: parent_rx,
        parent_wake_read,
        done: done_flag,
        error: error_flag,
        join,
    })
}

// ---------------------------------------------------------------------------
// Thread-local V8 host loop
// ---------------------------------------------------------------------------

/// Bootstrap a V8 Isolate on the calling thread and run its event loop.
///
/// Mirrors `runtime::run()` but evaluates `_bootstrap.mjs` instead of
/// `_main.mjs`, and seeds `FinoState` with the channel/wake-pipe endpoints
/// for cross-thread messaging.
fn run_thread_isolate(config: IsolateConfig) -> Result<(), String> {
    // Close the pipe fds this thread owns when the function returns.
    let _wake_read_guard = OwnedFd(config.wake_read_fd);
    let _partner_write_guard = OwnedFd(config.partner_wake_write_fd);

    // V8 is initialized once globally; safe to call from any thread.
    crate::runtime::init_v8();

    let mut params = v8::CreateParams::default();
    params = params.heap_limits(0, 1 << 30);
    // Share the same allocator as the main Isolate so SAB backing stores are
    // accessible across both Isolates.
    params = params.array_buffer_allocator(crate::runtime::shared_allocator().clone());

    let isolate = &mut v8::Isolate::new(params);
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    // Thread realms run on their own OS thread — Atomics.wait() is safe here.
    isolate.set_allow_atomics_wait(true);
    isolate.set_host_import_module_dynamically_callback(loader::dynamic_import_callback);
    isolate.set_host_initialize_import_meta_object_callback(loader::init_import_meta_callback);

    let isolate_scope = &mut v8::HandleScope::new(isolate);
    let root_queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);
    let context = v8::Context::new(isolate_scope, Default::default());
    context.set_microtask_queue(&root_queue);

    let bootstrap_module_global: v8::Global<v8::Module>;
    let state_rc: Rc<RefCell<FinoState>>;

    // -------------------------------------------------------------------
    // Setup: init FinoState, compile+evaluate _bootstrap.mjs, first pump.
    // -------------------------------------------------------------------
    {
        let scope = &mut v8::ContextScope::new(isolate_scope, context);

        let state = FinoState {
            process_env: config.process_env,
            package_map_json: config.package_map_json,
            root_queue,
            providers: config.providers,
            builtin_cache: HashMap::new(),
            fs_cache: HashMap::new(),
            builtin_script_ids: HashSet::new(),
            builtin_specifiers: HashMap::new(),
            module_paths: HashMap::new(),
            source_maps: HashMap::new(),
            resolve_fn: None,
            init_meta_fn: None,
            loop_step_fn: None,
            on_done_fn: None,
            sync_call_fn: None,
            sync_call_resolver: None,
            tla_resolvers: Vec::new(),
            cpu_profiler: None,
            child_contexts: Vec::new(),
            pending_creates: Vec::new(),
            entry_path: Some(config.entry_path),
            terminated: false,
            port: None,
            channel_rx: Some(config.channel_rx),
            channel_tx: Some(config.channel_tx),
            wake_read_fd: Some(config.wake_read_fd),
            wake_write_fd: Some(config.partner_wake_write_fd),
            thread_contexts: Vec::new(),
        };

        context.set_slot(Rc::new(RefCell::new(state)));

        // CPED: empty JS Array as the live async-context frame.
        let initial_frame = v8::Array::new(scope, 0);
        scope.set_continuation_preserved_embedder_data(initial_frame.into());

        // Compile and evaluate _bootstrap.mjs.
        let bootstrap_src = include_str!(concat!(env!("OUT_DIR"), "/js/_bootstrap.mjs"));
        let bootstrap_map = include_str!(concat!(env!("OUT_DIR"), "/js/_bootstrap.mjs.map"));

        let bootstrap_module = {
            let tc = &mut v8::TryCatch::new(scope);
            loader::register_source_map_from_json(tc, "_bootstrap.mjs", bootstrap_map);
            match loader::compile_source_module(
                tc,
                bootstrap_src,
                "_bootstrap.mjs",
                Some(bootstrap_map),
            ) {
                Some(m) => m,
                None => {
                    let msg = catch_message(tc)
                        .unwrap_or_else(|| "Failed to compile _bootstrap.mjs".to_string());
                    return Err(msg);
                }
            }
        };

        loader::register_as_builtin(scope, bootstrap_module, "internal:bootstrap");

        {
            let tc = &mut v8::TryCatch::new(scope);
            if bootstrap_module
                .instantiate_module(tc, loader::resolve_module_callback)
                .is_none()
            {
                let msg = catch_message(tc)
                    .unwrap_or_else(|| "Failed to instantiate _bootstrap.mjs".to_string());
                return Err(msg);
            }
        }

        {
            let tc = &mut v8::TryCatch::new(scope);
            if bootstrap_module.evaluate(tc).is_none() {
                let msg = catch_message(tc)
                    .unwrap_or_else(|| "Failed to evaluate _bootstrap.mjs".to_string());
                return Err(msg);
            }
        }

        pump_and_checkpoint(scope);

        if bootstrap_module.get_status() == v8::ModuleStatus::Errored {
            let exc = bootstrap_module.get_exception();
            let msg = exc
                .to_string(scope)
                .map(|s| s.to_rust_string_lossy(scope))
                .unwrap_or_else(|| "Unknown error in _bootstrap.mjs".to_string());
            return Err(msg);
        }

        state_rc = get_state(scope);
        bootstrap_module_global = v8::Global::new(scope, bootstrap_module);
    } // ContextScope dropped — isolate_scope is free.

    // -------------------------------------------------------------------
    // Host loop (same structure as runtime::run).
    // -------------------------------------------------------------------
    'main: loop {
        let should_continue = 'step: {
            let scope = &mut v8::ContextScope::new(isolate_scope, context);

            let loop_step_fn = match state_rc.borrow().loop_step_fn.clone() {
                Some(f) => f,
                None => break 'main,
            };

            let should_continue = {
                let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
                v8::Local::new(scope, &loop_step_fn)
                    .call(scope, undef, &[])
                    .map(|v| v.boolean_value(scope))
                    .unwrap_or(false)
            };

            if should_continue {
                let (maybe_fn, maybe_resolver) = {
                    let mut st = state_rc.borrow_mut();
                    (st.sync_call_fn.take(), st.sync_call_resolver.take())
                };

                if let (Some(fn_ref), Some(resolver_ref)) = (maybe_fn, maybe_resolver) {
                    let call_result: Result<v8::Global<v8::Value>, v8::Global<v8::Value>> = {
                        let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
                        let tc = &mut v8::TryCatch::new(scope);
                        let fn_local = v8::Local::new(tc, &fn_ref);
                        match fn_local.call(tc, undef, &[]) {
                            Some(result) => Ok(v8::Global::new(tc, result)),
                            None => {
                                let exc =
                                    tc.exception().unwrap_or_else(|| v8::undefined(tc).into());
                                Err(v8::Global::new(tc, exc))
                            }
                        }
                    };

                    match call_result {
                        Ok(result_ref) => {
                            let resolver_local = v8::Local::new(scope, &resolver_ref);
                            let result_local = v8::Local::new(scope, &result_ref);
                            let _ = resolver_local.resolve(scope, result_local);
                        }
                        Err(exc_ref) => {
                            let resolver_local = v8::Local::new(scope, &resolver_ref);
                            let exc_local = v8::Local::new(scope, &exc_ref);
                            let _ = resolver_local.reject(scope, exc_local);
                        }
                    }

                    pump_and_checkpoint(scope);
                }
            }

            break 'step should_continue;
        }; // ContextScope dropped — isolate_scope is free.

        if !should_continue {
            break 'main;
        }

        realm::process_pending_creates(isolate_scope, &state_rc);
    }

    // -------------------------------------------------------------------
    // Teardown: terminate children, call onDone, dispose profiler.
    // -------------------------------------------------------------------
    {
        let scope = &mut v8::ContextScope::new(isolate_scope, context);

        realm::terminate_all_children(scope);

        let on_done_fn = state_rc.borrow().on_done_fn.clone();
        if let Some(f) = on_done_fn {
            let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
            v8::Local::new(scope, &f).call(scope, undef, &[]);
            pump_and_checkpoint(scope);
        }

        if let Some(ptr) = state_rc.borrow_mut().cpu_profiler.take() {
            unsafe { crate::profiler::dispose_profiler(ptr) };
        }

        let bootstrap_module = v8::Local::new(scope, &bootstrap_module_global);
        if bootstrap_module.get_status() == v8::ModuleStatus::Errored {
            let exc = bootstrap_module.get_exception();
            let msg = exc
                .to_string(scope)
                .map(|s| s.to_rust_string_lossy(scope))
                .unwrap_or_else(|| "Unknown error in _bootstrap.mjs".to_string());
            return Err(msg);
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// internal:thread-port — native channel send/recv for thread realms
// ---------------------------------------------------------------------------

/// Create the `internal:thread-port` synthetic module.
///
/// Exports:
/// - `nativeSend(bytes: Uint8Array): void` — serializes bytes via the mpsc
///   channel and wakes the partner Isolate's event loop.
/// - `nativeRecv(): Uint8Array[]` — drains all buffered messages from the
///   channel and returns them as an Array of Uint8Arrays.
/// - `getWakeReadFd(): number` — returns the own wake-pipe read fd (or -1 if
///   this is not a thread realm), for registration with `loop.readable()`.
pub fn create_thread_port_module<'s>(
    scope: &mut v8::HandleScope<'s>,
) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> =
        ["nativeSend", "nativeRecv", "getWakeReadFd"]
            .iter()
            .map(|n| v8::String::new(scope, n).unwrap())
            .collect();

    let module_name = v8::String::new(scope, "internal:thread-port").unwrap();
    v8::Module::create_synthetic_module(
        scope,
        module_name,
        &export_names,
        thread_port_eval_steps,
    )
}

fn thread_port_eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };

    macro_rules! set_fn {
        ($name:expr, $cb:expr) => {{
            let tmpl = v8::FunctionTemplate::new(scope, $cb);
            let func = tmpl.get_function(scope)?;
            let key = v8::String::new(scope, $name)?;
            module.set_synthetic_module_export(scope, key, func.into())?;
        }};
    }

    set_fn!("nativeSend", native_send);
    set_fn!("nativeRecv", native_recv);
    set_fn!("getWakeReadFd", native_get_wake_read_fd);

    Some(v8::undefined(scope).into())
}

/// JS: `nativeSend(bytes: Uint8Array, stores?: Uint8Array[], ports?: [handle,wakeReadFd][]): void`
///
/// Sends the byte payload (and optional transfer stores + port transfer infos)
/// to the partner Isolate via mpsc and writes 1 byte to the partner's wake pipe.
fn native_send(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let bytes_arg = args.get(0);
    let Ok(u8a) = v8::Local::<v8::Uint8Array>::try_from(bytes_arg) else {
        let msg = v8::String::new(scope, "nativeSend: first argument must be a Uint8Array").unwrap();
        let exc = v8::Exception::type_error(scope, msg);
        scope.throw_exception(exc);
        return;
    };

    // Copy main bytes.
    let data: Vec<u8> = {
        let Some(ab) = u8a.buffer(scope) else { return };
        let Some(data_ptr) = ab.data() else { return };
        let offset = u8a.byte_offset();
        let len = u8a.byte_length();
        // SAFETY: data_ptr points into a live V8 ArrayBuffer owned for this scope.
        unsafe {
            std::slice::from_raw_parts((data_ptr.as_ptr() as *const u8).add(offset), len).to_vec()
        }
    };

    // Copy transfer stores (optional second arg — Array of Uint8Array).
    let transfer_stores: Vec<Vec<u8>> =
        if let Ok(arr) = v8::Local::<v8::Array>::try_from(args.get(1)) {
            let count = arr.length();
            let mut stores = Vec::with_capacity(count as usize);
            for i in 0..count {
                let idx = v8::Integer::new(scope, i as i32);
                if let Some(elem) = arr.get(scope, idx.into())
                    && let Ok(su8a) = v8::Local::<v8::Uint8Array>::try_from(elem)
                {
                    let Some(sab) = su8a.buffer(scope) else { continue };
                    let Some(sptr) = sab.data() else { continue };
                    let soff = su8a.byte_offset();
                    let slen = su8a.byte_length();
                    // SAFETY: same as above.
                    let raw = unsafe {
                        std::slice::from_raw_parts(
                            (sptr.as_ptr() as *const u8).add(soff),
                            slen,
                        )
                        .to_vec()
                    };
                    stores.push(raw);
                }
            }
            stores
        } else {
            Vec::new()
        };

    // Port transfer infos (optional third arg — Array of [handle, wakeReadFd]).
    let transfer_ports = extract_port_infos(scope, args.get(2));

    let msg = ThreadMessage { data, transfer_stores, transfer_ports };

    // Extract tx and wake_write_fd without holding the borrow during send.
    let state_rc = get_state(scope);
    let (maybe_tx, maybe_wake_write) = {
        let st = state_rc.borrow();
        (st.channel_tx.clone(), st.wake_write_fd)
    };

    if let (Some(tx), Some(wake_write)) = (maybe_tx, maybe_wake_write) {
        let _ = tx.send(msg);
        // Write a single byte to the partner's wake pipe to unblock its wait.
        let byte: [u8; 1] = [1];
        // SAFETY: wake_write is a valid open fd owned by this runtime.
        unsafe { libc::write(wake_write, byte.as_ptr() as *const _, 1) };
    }
}

/// JS: `nativeRecv(): [Uint8Array, ...Uint8Array[]][]`
///
/// Non-blocking drain of `channel_rx`. Returns all currently buffered messages
/// as a JS Array of inner Arrays. Each inner Array has the main bytes at `[0]`
/// and transfer-store bytes at `[1..]`. Also drains wake bytes from the read
/// pipe so the next `loop.readable()` arms cleanly.
fn native_recv(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    // Drain the channel first (before any V8 allocations).
    let (messages, maybe_wake_read) = {
        let state_rc = get_state(scope);
        let st = state_rc.borrow();
        let msgs: Vec<ThreadMessage> = if let Some(rx) = st.channel_rx.as_ref() {
            let mut v = Vec::new();
            while let Ok(msg) = rx.try_recv() {
                v.push(msg);
            }
            v
        } else {
            Vec::new()
        };
        (msgs, st.wake_read_fd)
    };

    // Drain wake bytes so the fd doesn't remain permanently readable.
    if let Some(wake_read) = maybe_wake_read {
        let mut discard = [0u8; 256];
        // Non-blocking; EAGAIN means no more bytes — ignore error.
        // SAFETY: discard is a valid buffer; wake_read is a valid open fd.
        unsafe { libc::read(wake_read, discard.as_mut_ptr() as *mut _, discard.len()) };
    }

    rv.set(crate::realm::transit::build_message_array(scope, messages).into());
}

/// JS: `getWakeReadFd(): number`
///
/// Returns the own wake-pipe read fd (≥ 0) for use with `loop.readable()`,
/// or -1 if this context is not a thread realm.
fn native_get_wake_read_fd(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let state_rc = get_state(scope);
    let fd = state_rc.borrow().wake_read_fd.unwrap_or(-1);
    rv.set(v8::Integer::new(scope, fd).into());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract `[[handle: number, wakeReadFd: number], ...]` from a JS value.
pub(crate) fn extract_port_infos(
    scope: &mut v8::HandleScope,
    val: v8::Local<v8::Value>,
) -> Vec<TransferredPortInfo> {
    let Ok(arr) = v8::Local::<v8::Array>::try_from(val) else {
        return Vec::new();
    };
    let count = arr.length();
    let mut infos = Vec::with_capacity(count as usize);
    for i in 0..count {
        let idx = v8::Integer::new(scope, i as i32);
        let Some(elem) = arr.get(scope, idx.into()) else { continue };
        let Ok(pair) = v8::Local::<v8::Array>::try_from(elem) else { continue };
        let zero = v8::Integer::new(scope, 0);
        let one  = v8::Integer::new(scope, 1);
        let Some(h_val)  = pair.get(scope, zero.into()) else { continue };
        let Some(fd_val) = pair.get(scope, one.into())  else { continue };
        let handle       = h_val.integer_value(scope).unwrap_or(-1) as u32;
        let wake_read_fd = fd_val.integer_value(scope).unwrap_or(-1) as i32;
        infos.push(TransferredPortInfo { handle, wake_read_fd });
    }
    infos
}

fn pump_and_checkpoint(scope: &mut v8::HandleScope) {
    let platform = v8::V8::get_current_platform();
    while v8::Platform::pump_message_loop(&platform, scope, false) {}
    let state_rc = get_state(scope);
    let queue_ptr = unsafe { root_queue_ptr(&state_rc) };
    let isolate: &mut v8::Isolate = scope.as_mut();
    unsafe { &*queue_ptr }.perform_checkpoint(isolate);
}

fn catch_message(tc: &mut v8::TryCatch<v8::HandleScope>) -> Option<String> {
    if !tc.has_caught() {
        return None;
    }
    tc.exception().and_then(|exc| {
        exc.to_object(tc)
            .and_then(|obj| v8::String::new(tc, "stack").and_then(|key| obj.get(tc, key.into())))
            .and_then(|stack| stack.to_string(tc).map(|s| s.to_rust_string_lossy(tc)))
            .or_else(|| exc.to_string(tc).map(|s| s.to_rust_string_lossy(tc)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify that `done` is set and `error` is populated even when the thread
    /// body panics — i.e. that `catch_unwind` properly contains the panic.
    #[test]
    fn catch_unwind_sets_done_and_error_on_panic() {
        let done = Arc::new(AtomicBool::new(false));
        let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let done_clone = done.clone();
        let error_clone = error.clone();

        let handle = std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                panic!("deliberate test panic");
            }));
            done_clone.store(true, Ordering::Release);
            let msg = match result {
                Ok(Ok(())) => None,
                Ok(Err(e)) => Some(e),
                Err(payload) => {
                    let desc = payload
                        .downcast_ref::<String>()
                        .map(|s| s.clone())
                        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_else(|| "panicked".to_string());
                    Some(format!("thread realm panicked: {desc}"))
                }
            };
            if let Some(msg) = msg {
                *error_clone.lock().unwrap() = Some(msg);
            }
        });
        handle.join().unwrap();

        assert!(
            done.load(Ordering::Acquire),
            "done flag must be set even after a panic"
        );
        let err = error.lock().unwrap();
        assert!(err.is_some(), "error should be populated after a panic");
        assert!(
            err.as_ref().unwrap().contains("deliberate test panic"),
            "error message should contain the panic description"
        );
    }

    /// Verify that a clean return also sets done but leaves error as None.
    #[test]
    fn catch_unwind_clean_exit_no_error() {
        let done = Arc::new(AtomicBool::new(false));
        let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let done_clone = done.clone();
        let error_clone = error.clone();

        let handle = std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                Ok::<(), String>(())
            }));
            done_clone.store(true, Ordering::Release);
            let msg: Option<String> = match result {
                Ok(Ok(())) => None,
                Ok(Err(e)) => Some(e),
                Err(_) => Some("panicked".to_string()),
            };
            if let Some(msg) = msg {
                *error_clone.lock().unwrap() = Some(msg);
            }
        });
        handle.join().unwrap();

        assert!(done.load(Ordering::Acquire), "done flag must be set on clean exit");
        assert!(
            error.lock().unwrap().is_none(),
            "error should be None on clean exit"
        );
    }
}
