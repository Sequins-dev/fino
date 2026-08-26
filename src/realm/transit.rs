//! Transit channels for cross-Isolate MessagePort transfer.
//!
//! When a MessagePort is transferred through a `ThreadPort.postMessage` call,
//! the partner port in the sender Isolate needs a new cross-thread transport.
//! `createTransitPair()` allocates two symmetric channel halves (each with its
//! own mpsc pair and wake pipe) stored in a global registry keyed by `u32`
//! handles.
//!
//! The JS side:
//! - Calls `createTransitChannel()` to get two handles + wake-read fds.
//! - Upgrades the partner port (P2) with the P2-half handle.
//! - Ships the Q-half info (`{ handle, wakeReadFd }`) in the `ThreadMessage`.
//! - On the receiver, creates a new `MessagePort` in transit mode using the
//!   Q-half handle and wake-read fd.
//!
//! # Module: `internal:transit-port`
//!
//! Exports:
//! - `createTransitChannel() → { p2Handle, p2WakeReadFd, qHandle, qWakeReadFd }`
//! - `transitSend(handle, bytes, stores) → void`
//! - `transitRecv(handle) → [[Uint8Array[], PortInfo[]], ...]`
//!   where PortInfo = `[handle: number, wakeReadFd: number]` (a 2-element Array)

use std::{
    collections::HashMap,
    os::unix::io::RawFd,
    sync::{Mutex, OnceLock, mpsc},
};

use ::v8;

use crate::realm::thread::ThreadMessage;

// ---------------------------------------------------------------------------
// Global registry
// ---------------------------------------------------------------------------

pub struct TransitHalf {
    pub tx: mpsc::Sender<ThreadMessage>,
    pub rx: mpsc::Receiver<ThreadMessage>,
    /// Own wake-pipe read end — the JS side watches this via `loop.readable()`.
    pub wake_read_fd: RawFd,
    /// Partner's wake-pipe write end — written after each send to unblock partner.
    pub partner_wake_write_fd: RawFd,
}

// SAFETY: TransitHalf contains mpsc Sender/Receiver which are Send, and RawFd
// which is Send.  All access is serialized through the global Mutex.
unsafe impl Send for TransitHalf {}

struct TransitRegistry {
    next_handle: u32,
    halves: HashMap<u32, TransitHalf>,
}

static REGISTRY: OnceLock<Mutex<TransitRegistry>> = OnceLock::new();

fn registry() -> &'static Mutex<TransitRegistry> {
    REGISTRY.get_or_init(|| {
        Mutex::new(TransitRegistry {
            next_handle: 0,
            halves: HashMap::new(),
        })
    })
}

fn create_pipe() -> Result<(RawFd, RawFd), String> {
    let mut fds = [0i32; 2];
    let ret = unsafe { libc::pipe(fds.as_mut_ptr()) };
    if ret != 0 {
        return Err(format!(
            "pipe() failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    unsafe {
        libc::fcntl(fds[0], libc::F_SETFL, libc::O_NONBLOCK);
        libc::fcntl(fds[1], libc::F_SETFL, libc::O_NONBLOCK);
    }
    Ok((fds[0], fds[1]))
}

/// Create a symmetric transit channel pair.  Returns `(p2_handle, q_handle)`.
///
/// P2 half:
/// - tx → sends to Q   (P2 → Q direction)
/// - rx ← receives from Q (Q → P2 direction)
/// - wake_read_fd: P2 watches this (Q writes here after sending)
/// - partner_wake_write_fd: P2 writes here after sending (wakes Q)
///
/// Q half is symmetric.
pub fn create_transit_pair() -> Result<(u32, u32, RawFd, RawFd), String> {
    let (p2_to_q_tx, p2_to_q_rx) = mpsc::channel::<ThreadMessage>();
    let (q_to_p2_tx, q_to_p2_rx) = mpsc::channel::<ThreadMessage>();

    // Pipe A: P2 writes here to wake Q; Q reads here.
    let (q_wake_read, p2_wake_write) = create_pipe()?;
    // Pipe B: Q writes here to wake P2; P2 reads here.
    let (p2_wake_read, q_wake_write) = create_pipe()?;

    let p2_half = TransitHalf {
        tx: p2_to_q_tx,
        rx: q_to_p2_rx,
        wake_read_fd: p2_wake_read,
        partner_wake_write_fd: p2_wake_write,
    };
    let q_half = TransitHalf {
        tx: q_to_p2_tx,
        rx: p2_to_q_rx,
        wake_read_fd: q_wake_read,
        partner_wake_write_fd: q_wake_write,
    };

    let mut reg = registry().lock().unwrap();
    let p2_handle = reg.next_handle;
    reg.next_handle += 1;
    let q_handle = reg.next_handle;
    reg.next_handle += 1;

    let p2_wake_read_fd = p2_half.wake_read_fd;
    let q_wake_read_fd = q_half.wake_read_fd;

    reg.halves.insert(p2_handle, p2_half);
    reg.halves.insert(q_handle, q_half);

    Ok((p2_handle, q_handle, p2_wake_read_fd, q_wake_read_fd))
}

// ---------------------------------------------------------------------------
// Module: internal:transit-port
// ---------------------------------------------------------------------------

pub fn create_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> =
        ["createTransitChannel", "transitSend", "transitRecv"]
            .iter()
            .map(|n| v8::String::new(scope, n).unwrap())
            .collect();
    let module_name = v8::String::new(scope, "internal:transit-port").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    v8::callback_scope!(unsafe let scope, context);
    macro_rules! set_fn {
        ($name:expr, $cb:expr) => {{
            let tmpl = v8::FunctionTemplate::new(scope, $cb);
            let func = tmpl.get_function(scope)?;
            let key = v8::String::new(scope, $name)?;
            module.set_synthetic_module_export(scope, key, func.into())?;
        }};
    }
    set_fn!("createTransitChannel", native_create_transit_channel);
    set_fn!("transitSend", native_transit_send);
    set_fn!("transitRecv", native_transit_recv);
    Some(v8::undefined(scope).into())
}

// ---------------------------------------------------------------------------
// createTransitChannel() → { p2Handle, p2WakeReadFd, qHandle, qWakeReadFd }
// ---------------------------------------------------------------------------

fn native_create_transit_channel(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let (p2_handle, q_handle, p2_wake_read_fd, q_wake_read_fd) = match create_transit_pair() {
        Ok(t) => t,
        Err(e) => {
            let msg = v8::String::new(scope, &format!("createTransitChannel: {e}")).unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
    };

    let obj = v8::Object::new(scope);
    macro_rules! set_int {
        ($key:expr, $val:expr) => {{
            let k = v8::String::new(scope, $key).unwrap();
            let v = v8::Number::new(scope, $val as f64);
            obj.set(scope, k.into(), v.into());
        }};
    }
    set_int!("p2Handle", p2_handle);
    set_int!("p2WakeReadFd", p2_wake_read_fd);
    set_int!("qHandle", q_handle);
    set_int!("qWakeReadFd", q_wake_read_fd);

    rv.set(obj.into());
}

// ---------------------------------------------------------------------------
// transitSend(handle, bytes, stores?) → void
// ---------------------------------------------------------------------------

fn native_transit_send(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as u32;

    let Ok(u8a) = v8::Local::<v8::Uint8Array>::try_from(args.get(1)) else {
        let msg =
            v8::String::new(scope, "transitSend: second argument must be a Uint8Array").unwrap();
        let exc = v8::Exception::type_error(scope, msg);
        scope.throw_exception(exc);
        return;
    };

    let data: Vec<u8> = {
        let Some(ab) = u8a.buffer(scope) else { return };
        let Some(ptr) = ab.data() else { return };
        let offset = u8a.byte_offset();
        let len = u8a.byte_length();
        // SAFETY: ptr into live V8 AB, slice doesn't outlive this frame.
        unsafe { std::slice::from_raw_parts((ptr.as_ptr() as *const u8).add(offset), len).to_vec() }
    };

    let transfer_stores: Vec<Vec<u8>> =
        if let Ok(arr) = v8::Local::<v8::Array>::try_from(args.get(2)) {
            let count = arr.length();
            let mut stores = Vec::with_capacity(count as usize);
            for i in 0..count {
                let idx = v8::Integer::new(scope, i as i32);
                if let Some(elem) = arr.get(scope, idx.into())
                    && let Ok(su8a) = v8::Local::<v8::Uint8Array>::try_from(elem)
                {
                    let Some(sab) = su8a.buffer(scope) else {
                        continue;
                    };
                    let Some(sptr) = sab.data() else { continue };
                    let soff = su8a.byte_offset();
                    let slen = su8a.byte_length();
                    // SAFETY: same.
                    let raw = unsafe {
                        std::slice::from_raw_parts((sptr.as_ptr() as *const u8).add(soff), slen)
                            .to_vec()
                    };
                    stores.push(raw);
                }
            }
            stores
        } else {
            Vec::new()
        };

    let msg = ThreadMessage {
        header: Vec::new(),
        data,
        transfer_stores,
        transfer_ports: Vec::new(),
    };

    // Send and wake partner — all under a single lock acquisition.
    let partner_wake_write = {
        let mut reg = registry().lock().unwrap();
        match reg.halves.get_mut(&handle) {
            Some(half) => {
                let _ = half.tx.send(msg);
                half.partner_wake_write_fd
            }
            None => return,
        }
    };

    let byte: [u8; 1] = [1];
    // SAFETY: partner_wake_write is a valid open pipe fd.
    unsafe { libc::write(partner_wake_write, byte.as_ptr() as *const _, 1) };
}

// ---------------------------------------------------------------------------
// transitRecv(handle) → [[Uint8Array[], [handle, wakeReadFd][]], ...]
// ---------------------------------------------------------------------------

fn native_transit_recv(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as u32;

    let (messages, wake_read_fd) = {
        let reg = registry().lock().unwrap();
        match reg.halves.get(&handle) {
            Some(half) => {
                let mut msgs = Vec::new();
                while let Ok(m) = half.rx.try_recv() {
                    msgs.push(m);
                }
                (msgs, Some(half.wake_read_fd))
            }
            None => (Vec::new(), None),
        }
    };

    if let Some(fd) = wake_read_fd {
        let mut discard = [0u8; 256];
        // SAFETY: discard is valid; fd is a valid non-blocking pipe read end.
        unsafe { libc::read(fd, discard.as_mut_ptr() as *mut _, discard.len()) };
    }

    rv.set(build_message_array(scope, messages).into());
}

// ---------------------------------------------------------------------------
// Shared helper: build the JS return value for a batch of ThreadMessages.
//
// Returns: `[[Uint8Array[], [number, number][]], ...]`
//   outer[i][0] = Uint8Array[] (mainBytes at [0], storeBytes at [1..])
//   outer[i][1] = [handle, wakeReadFd][] per transferred port
// ---------------------------------------------------------------------------

pub fn build_message_array<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    messages: Vec<ThreadMessage>,
) -> v8::Local<'s, v8::Array> {
    let outer = v8::Array::new(scope, messages.len() as i32);
    for (i, msg) in messages.into_iter().enumerate() {
        // Build inner[0]: Uint8Array[] with main bytes + store bytes
        let bytes_arr_len = (1 + msg.transfer_stores.len()) as i32;
        let bytes_arr = v8::Array::new(scope, bytes_arr_len);

        // Main bytes at [0]
        let main = copy_bytes_to_u8a(scope, &msg.data);
        let zero = v8::Integer::new(scope, 0);
        if let Some(u8a) = main {
            bytes_arr.set(scope, zero.into(), u8a.into());
        }

        // Store bytes at [1..]
        for (j, store) in msg.transfer_stores.iter().enumerate() {
            if let Some(u8a) = copy_bytes_to_u8a(scope, store) {
                let idx = v8::Integer::new(scope, (j + 1) as i32);
                bytes_arr.set(scope, idx.into(), u8a.into());
            }
        }

        // Build inner[1]: [[handle, wakeReadFd], ...] per transferred port
        let ports_arr = v8::Array::new(scope, msg.transfer_ports.len() as i32);
        for (j, pi) in msg.transfer_ports.iter().enumerate() {
            let pair = v8::Array::new(scope, 2);
            let h = v8::Number::new(scope, pi.handle as f64);
            let fd = v8::Number::new(scope, pi.wake_read_fd as f64);
            let zero2 = v8::Integer::new(scope, 0);
            let one = v8::Integer::new(scope, 1);
            pair.set(scope, zero2.into(), h.into());
            pair.set(scope, one.into(), fd.into());
            let jidx = v8::Integer::new(scope, j as i32);
            ports_arr.set(scope, jidx.into(), pair.into());
        }

        // Wrap as a 3-element tuple: [bytesArr, portsArr, header]
        let tuple = v8::Array::new(scope, 3);
        let zero3 = v8::Integer::new(scope, 0);
        let one2 = v8::Integer::new(scope, 1);
        let two = v8::Integer::new(scope, 2);
        tuple.set(scope, zero3.into(), bytes_arr.into());
        tuple.set(scope, one2.into(), ports_arr.into());
        if let Some(header) = copy_bytes_to_u8a(scope, &msg.header) {
            tuple.set(scope, two.into(), header.into());
        }

        let oidx = v8::Integer::new(scope, i as i32);
        outer.set(scope, oidx.into(), tuple.into());
    }
    outer
}

fn copy_bytes_to_u8a<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bytes: &[u8],
) -> Option<v8::Local<'s, v8::Uint8Array>> {
    let len = bytes.len();
    let bs = v8::ArrayBuffer::new_backing_store(scope, len);
    if !bytes.is_empty() {
        let dst = bs.data()?.as_ptr() as *mut u8;
        // SAFETY: freshly allocated backing store, exclusive access.
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, len) };
    }
    let ab = v8::ArrayBuffer::with_backing_store(scope, &bs.make_shared());
    v8::Uint8Array::new(scope, ab, 0, len)
}
