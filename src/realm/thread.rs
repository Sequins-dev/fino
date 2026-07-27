//! Cross-isolate Realm transport primitives.
//!
//! Reactor-pooled and process-sandbox Realms use serialized messages and wake
//! descriptors to communicate with their parent. Isolate placement and worker
//! threads are owned by `scheduler_native`.

use ::v8;

use crate::state::get_state;

/// Info shipped alongside a message for each transferred MessagePort.
///
/// The receiver uses `handle` to look up the Q-half transit channel and
/// `wake_read_fd` to register with the event loop via `loop.readable()`.
#[derive(Debug)]
pub struct TransferredPortInfo {
    pub handle: u32,
    pub wake_read_fd: i32,
}

/// A message transmitted across cross-isolate Realm boundaries.
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
// internal:thread-port — native channel send/recv for cross-isolate realms
// ---------------------------------------------------------------------------

/// Create the `internal:thread-port` synthetic module.
///
/// Exports:
/// - `nativeSend(bytes: Uint8Array): void` — serializes bytes via the mpsc
///   channel and wakes the partner Isolate's event loop.
/// - `nativeRecv(): Uint8Array[]` — drains all buffered messages from the
///   channel and returns them as an Array of Uint8Arrays.
/// - `getWakeReadFd(): number` — returns the own wake-pipe read fd (or -1 if
///   this is not a cross-isolate realm), for registration with `loop.readable()`.
pub fn create_thread_port_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = ["nativeSend", "nativeRecv", "getWakeReadFd"]
        .iter()
        .map(|n| v8::String::new(scope, n).unwrap())
        .collect();

    let module_name = v8::String::new(scope, "internal:thread-port").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, thread_port_eval_steps)
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
        let msg =
            v8::String::new(scope, "nativeSend: first argument must be a Uint8Array").unwrap();
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
                    let Some(sab) = su8a.buffer(scope) else {
                        continue;
                    };
                    let Some(sptr) = sab.data() else { continue };
                    let soff = su8a.byte_offset();
                    let slen = su8a.byte_length();
                    // SAFETY: same as above.
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

    // Port transfer infos (optional third arg — Array of [handle, wakeReadFd]).
    let transfer_ports = extract_port_infos(scope, args.get(2));

    let msg = ThreadMessage {
        data,
        transfer_stores,
        transfer_ports,
    };

    // Extract tx and wake_write_fd without holding the borrow during send.
    let state_rc = get_state(scope);
    let (maybe_tx, maybe_wake_write) = {
        let st = state_rc.borrow();
        (st.channel_tx.clone(), st.wake_write_fd)
    };

    if let Some(tx) = maybe_tx {
        let _ = tx.send(msg);
        // Reactor-pooled realms write a wake byte so the partner loop unblocks.
        // Process realms (wake_write_fd = None) wake the partner via the socket
        // write in their bridge thread — no explicit wake byte needed here.
        if let Some(wake_write) = maybe_wake_write {
            let byte: [u8; 1] = [1];
            // SAFETY: wake_write is a valid open fd owned by this runtime.
            unsafe { libc::write(wake_write, byte.as_ptr() as *const _, 1) };
        }
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
/// or -1 if this context does not have a cross-isolate transport.
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
        let Some(elem) = arr.get(scope, idx.into()) else {
            continue;
        };
        let Ok(pair) = v8::Local::<v8::Array>::try_from(elem) else {
            continue;
        };
        let zero = v8::Integer::new(scope, 0);
        let one = v8::Integer::new(scope, 1);
        let Some(h_val) = pair.get(scope, zero.into()) else {
            continue;
        };
        let Some(fd_val) = pair.get(scope, one.into()) else {
            continue;
        };
        let handle = h_val.integer_value(scope).unwrap_or(-1) as u32;
        let wake_read_fd = fd_val.integer_value(scope).unwrap_or(-1) as i32;
        infos.push(TransferredPortInfo {
            handle,
            wake_read_fd,
        });
    }
    infos
}
