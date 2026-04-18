//! BroadcastChannel registry — cross-Realm pub/sub.
//!
//! A global, process-wide registry maps channel names to subscriber lists.
//! Each subscriber owns an mpsc receiver and a wake-pipe read fd that the
//! JS side watches via `loop.readable()`.  Publishing serialises the message
//! bytes once and fans them out to every subscriber on the same channel name
//! except the originator.
//!
//! # Module: `internal:broadcast`
//!
//! Exports:
//! - `subscribe(name: string)  → { handle: number, wakeReadFd: number }`
//! - `publish(name: string, bytes: Uint8Array, originHandle: number) → void`
//! - `receive(handle: number)  → Uint8Array[]`
//! - `unsubscribe(handle: number) → void`

use std::{
    collections::HashMap,
    os::unix::io::RawFd,
    sync::{Mutex, OnceLock, mpsc},
};

use ::v8;

// ---------------------------------------------------------------------------
// Registry data structures
// ---------------------------------------------------------------------------

/// Entry stored in the by-name fan-out list.
struct FanoutEntry {
    handle: u32,
    tx: mpsc::Sender<Vec<u8>>,
    /// Write 1 byte here after each send to wake the subscriber's loop watcher.
    wake_write_fd: RawFd,
}

/// Per-handle state held for the subscriber.
struct SubscriberState {
    name: String,
    rx: mpsc::Receiver<Vec<u8>>,
    wake_read_fd: RawFd,
    wake_write_fd: RawFd,
}

struct BroadcastRegistry {
    next_handle: u32,
    /// name → list of active subscribers on that channel.
    by_name: HashMap<String, Vec<FanoutEntry>>,
    /// handle → subscriber state.
    by_handle: HashMap<u32, SubscriberState>,
}

static REGISTRY: OnceLock<Mutex<BroadcastRegistry>> = OnceLock::new();

fn registry() -> &'static Mutex<BroadcastRegistry> {
    REGISTRY.get_or_init(|| {
        Mutex::new(BroadcastRegistry {
            next_handle: 0,
            by_name: HashMap::new(),
            by_handle: HashMap::new(),
        })
    })
}

fn create_pipe() -> Result<(RawFd, RawFd), String> {
    let mut fds = [0i32; 2];
    let ret = unsafe { libc::pipe(fds.as_mut_ptr()) };
    if ret != 0 {
        return Err(format!("pipe() failed: {}", std::io::Error::last_os_error()));
    }
    // Set both ends non-blocking.
    unsafe {
        libc::fcntl(fds[0], libc::F_SETFL, libc::O_NONBLOCK);
        libc::fcntl(fds[1], libc::F_SETFL, libc::O_NONBLOCK);
    }
    Ok((fds[0], fds[1]))
}

// ---------------------------------------------------------------------------
// Core Rust API
// ---------------------------------------------------------------------------

/// Register a new subscriber for `name`.  Returns `(handle, wake_read_fd)`.
pub fn subscribe(name: &str) -> Result<(u32, RawFd), String> {
    let (wake_read_fd, wake_write_fd) = create_pipe()?;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();

    let mut reg = registry().lock().unwrap();
    let handle = reg.next_handle;
    reg.next_handle += 1;

    reg.by_name
        .entry(name.to_string())
        .or_default()
        .push(FanoutEntry { handle, tx, wake_write_fd });

    reg.by_handle.insert(
        handle,
        SubscriberState {
            name: name.to_string(),
            rx,
            wake_read_fd,
            wake_write_fd,
        },
    );

    Ok((handle, wake_read_fd))
}

/// Fan out `bytes` to all subscribers on `name` except `origin_handle`.
pub fn publish(name: &str, bytes: Vec<u8>, origin_handle: u32) {
    let mut reg = registry().lock().unwrap();

    let Some(entries) = reg.by_name.get_mut(name) else { return };

    // Collect wake fds for dead senders so we can remove them afterward.
    let mut dead: Vec<u32> = Vec::new();

    for entry in entries.iter() {
        if entry.handle == origin_handle {
            continue;
        }
        if entry.tx.send(bytes.clone()).is_err() {
            // Receiver dropped — subscriber must have been unsubscribed without
            // removing the fanout entry.  Schedule for removal.
            dead.push(entry.handle);
            continue;
        }
        let byte: [u8; 1] = [1];
        // SAFETY: wake_write_fd is a valid open pipe write end.
        unsafe { libc::write(entry.wake_write_fd, byte.as_ptr() as *const _, 1) };
    }

    if !dead.is_empty() {
        entries.retain(|e| !dead.contains(&e.handle));
    }
}

/// Drain all pending messages for `handle`.  Also drains the wake pipe so it
/// is empty when `loop.readable()` is re-registered.
pub fn receive(handle: u32) -> Vec<Vec<u8>> {
    let reg = registry().lock().unwrap();

    let Some(state) = reg.by_handle.get(&handle) else {
        return Vec::new();
    };

    let mut messages = Vec::new();
    while let Ok(msg) = state.rx.try_recv() {
        messages.push(msg);
    }

    // Drain the wake pipe so the fd is clean for the next registration.
    let mut discard = [0u8; 256];
    // SAFETY: discard is valid; fd is a valid non-blocking pipe read end.
    unsafe { libc::read(state.wake_read_fd, discard.as_mut_ptr() as *mut _, discard.len()) };

    messages
}

/// Write a byte to the subscriber's own wake pipe, unblocking any pending
/// `loop.readable(wakeReadFd)` call.  Used by `close()` to let the async
/// receive loop detect that the channel is closed and call `unsubscribe`.
pub fn wake_subscriber(handle: u32) {
    let reg = registry().lock().unwrap();
    if let Some(state) = reg.by_handle.get(&handle) {
        let byte: [u8; 1] = [1];
        // SAFETY: wake_write_fd is a valid open pipe write end.
        unsafe { libc::write(state.wake_write_fd, byte.as_ptr() as *const _, 1) };
    }
}

/// Remove the subscriber and close its pipe fds.
pub fn unsubscribe(handle: u32) {
    let mut reg = registry().lock().unwrap();

    let Some(state) = reg.by_handle.remove(&handle) else { return };

    // Remove from fan-out list.
    if let Some(entries) = reg.by_name.get_mut(&state.name) {
        entries.retain(|e| e.handle != handle);
        if entries.is_empty() {
            reg.by_name.remove(&state.name);
        }
    }

    // Close fds.
    unsafe {
        libc::close(state.wake_read_fd);
        libc::close(state.wake_write_fd);
    }
}

// ---------------------------------------------------------------------------
// Synthetic module: internal:broadcast
// ---------------------------------------------------------------------------

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> =
        ["subscribe", "publish", "receive", "unsubscribe", "wakeSubscriber"]
            .iter()
            .map(|n| v8::String::new(scope, n).unwrap())
            .collect();
    let module_name = v8::String::new(scope, "internal:broadcast").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
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
    set_fn!("subscribe", native_subscribe);
    set_fn!("publish", native_publish);
    set_fn!("receive", native_receive);
    set_fn!("unsubscribe", native_unsubscribe);
    set_fn!("wakeSubscriber", native_wake_subscriber);
    Some(v8::undefined(scope).into())
}

// ---------------------------------------------------------------------------
// subscribe(name: string) → { handle: number, wakeReadFd: number }
// ---------------------------------------------------------------------------

fn native_subscribe(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let name_val = args.get(0);
    let Some(name_str) = name_val.to_string(scope) else {
        let msg = v8::String::new(scope, "subscribe: first argument must be a string").unwrap();
        let exc = v8::Exception::type_error(scope, msg);
        scope.throw_exception(exc);
        return;
    };
    let name = name_str.to_rust_string_lossy(scope);

    let (handle, wake_read_fd) = match subscribe(&name) {
        Ok(t) => t,
        Err(e) => {
            let msg = v8::String::new(scope, &format!("subscribe: {e}")).unwrap();
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
    set_int!("handle", handle);
    set_int!("wakeReadFd", wake_read_fd);
    rv.set(obj.into());
}

// ---------------------------------------------------------------------------
// publish(name: string, bytes: Uint8Array, originHandle: number) → void
// ---------------------------------------------------------------------------

fn native_publish(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let name_val = args.get(0);
    let Some(name_str) = name_val.to_string(scope) else {
        let msg = v8::String::new(scope, "publish: first argument must be a string").unwrap();
        let exc = v8::Exception::type_error(scope, msg);
        scope.throw_exception(exc);
        return;
    };
    let name = name_str.to_rust_string_lossy(scope);

    let Ok(u8a) = v8::Local::<v8::Uint8Array>::try_from(args.get(1)) else {
        let msg = v8::String::new(scope, "publish: second argument must be a Uint8Array").unwrap();
        let exc = v8::Exception::type_error(scope, msg);
        scope.throw_exception(exc);
        return;
    };

    let bytes: Vec<u8> = {
        let Some(ab) = u8a.buffer(scope) else { return };
        let Some(ptr) = ab.data() else { return };
        let offset = u8a.byte_offset();
        let len = u8a.byte_length();
        // SAFETY: ptr is into a live V8 ArrayBuffer; slice doesn't outlive this frame.
        unsafe { std::slice::from_raw_parts((ptr.as_ptr() as *const u8).add(offset), len).to_vec() }
    };

    let origin_handle = args.get(2).integer_value(scope).unwrap_or(-1) as u32;

    publish(&name, bytes, origin_handle);
}

// ---------------------------------------------------------------------------
// receive(handle: number) → Uint8Array[]
// ---------------------------------------------------------------------------

fn native_receive(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as u32;

    let messages = receive(handle);
    let arr = v8::Array::new(scope, messages.len() as i32);

    for (i, msg) in messages.into_iter().enumerate() {
        let len = msg.len();
        let bs = v8::ArrayBuffer::new_backing_store(scope, len);
        if !msg.is_empty() && let Some(ptr) = bs.data() {
            let dst = ptr.as_ptr() as *mut u8;
            // SAFETY: freshly allocated backing store with exclusive access.
            unsafe { std::ptr::copy_nonoverlapping(msg.as_ptr(), dst, len) };
        }
        let ab = v8::ArrayBuffer::with_backing_store(scope, &bs.make_shared());
        if let Some(u8a) = v8::Uint8Array::new(scope, ab, 0, len) {
            let idx = v8::Integer::new(scope, i as i32);
            arr.set(scope, idx.into(), u8a.into());
        }
    }

    rv.set(arr.into());
}

// ---------------------------------------------------------------------------
// unsubscribe(handle: number) → void
// ---------------------------------------------------------------------------

fn native_unsubscribe(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as u32;
    unsubscribe(handle);
}

// ---------------------------------------------------------------------------
// wakeSubscriber(handle: number) → void
// ---------------------------------------------------------------------------

fn native_wake_subscriber(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as u32;
    wake_subscriber(handle);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribe_and_receive() {
        let (h1, _fd1) = subscribe("test-ch-1").unwrap();
        let (h2, _fd2) = subscribe("test-ch-1").unwrap();

        publish("test-ch-1", b"hello".to_vec(), h1);

        // h1 should NOT receive its own message.
        let msgs1 = receive(h1);
        assert!(msgs1.is_empty(), "originator should not receive its own message");

        // h2 should receive the message.
        let msgs2 = receive(h2);
        assert_eq!(msgs2.len(), 1);
        assert_eq!(msgs2[0], b"hello");

        unsubscribe(h1);
        unsubscribe(h2);
    }

    #[test]
    fn unsubscribe_removes_from_fanout() {
        let (h, _fd) = subscribe("test-ch-2").unwrap();
        unsubscribe(h);

        // Subscribing again should work and produce a fresh handle.
        let (h2, _fd2) = subscribe("test-ch-2").unwrap();
        assert_ne!(h, h2);
        unsubscribe(h2);
    }

    #[test]
    fn publish_to_empty_channel_is_noop() {
        // Should not panic.
        publish("test-ch-nonexistent", b"data".to_vec(), 9999);
    }
}
