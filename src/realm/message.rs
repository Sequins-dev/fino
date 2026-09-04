//! Shared cross-realm port send/recv paths.
//!
//! The thread, sandbox, and process realm transports each expose a
//! `*Send`/`*Recv` native pair. The bodies were previously near-identical
//! copies: read a header `Uint8Array`, copy the payload, copy transfer
//! stores, build a `ThreadMessage`, send over mpsc, and write a wake byte on
//! the send side; drain the channel, drain the wake pipe, and rebuild the JS
//! message array on the receive side. Only the transport lookup differed.
//! These helpers own the shared behavior; each native is a thin lookup plus
//! a call.

use super::bytes;
use super::thread::ThreadMessage;
use std::os::unix::io::RawFd;
use std::sync::mpsc::Sender;

/// The sending half of a cross-realm transport: the mpsc sender plus the
/// optional partner wake-pipe write end. `wake_write` is `None` for process
/// realms, whose bridge thread wakes the partner via its socket write.
pub struct SendTransport {
    pub tx: Sender<ThreadMessage>,
    pub wake_write: Option<RawFd>,
}

/// The receiving half of a cross-realm transport.
///
/// `mpsc::Receiver` is not cloneable, so the transport borrows the receiver
/// from the realm handle for the duration of the drain. `wake_read` is the
/// optional own wake-pipe read end to drain after receiving.
pub struct RecvTransport<'a> {
    pub rx: &'a std::sync::mpsc::Receiver<ThreadMessage>,
    pub wake_read: Option<RawFd>,
}

/// Build a `ThreadMessage` from the JS `send(header, data, transferStores,
/// transferPorts)` argument shape.
///
/// `data_arg` must be a `Uint8Array`; on mismatch this throws a `TypeError`
/// named after `native` and returns `None`. `transfer_stores_arg` and
/// `transfer_ports_arg` may be undefined.
pub fn build_message_from_args(
    scope: &mut v8::PinScope,
    native: &str,
    header_arg: v8::Local<v8::Value>,
    data_arg: v8::Local<v8::Value>,
    transfer_stores_arg: v8::Local<v8::Value>,
    transfer_ports_arg: v8::Local<v8::Value>,
) -> Option<ThreadMessage> {
    let header = bytes::u8a_to_vec(scope, header_arg).unwrap_or_default();
    let Ok(u8a) = v8::Local::<v8::Uint8Array>::try_from(data_arg) else {
        crate::v8util::throw_type_error(
            scope,
            &format!("{native}: payload argument must be a Uint8Array"),
        );
        return None;
    };
    let data = bytes::u8a_slice_to_vec(scope, u8a)?;
    let transfer_stores = bytes::copy_transfer_stores(scope, transfer_stores_arg);
    let transfer_ports = super::thread::extract_port_infos(scope, transfer_ports_arg);
    Some(ThreadMessage {
        header,
        data,
        transfer_stores,
        transfer_ports,
    })
}

/// Send `message` over `transport`, writing the partner wake byte when the
/// transport carries one.
pub fn send_message(transport: &SendTransport, message: ThreadMessage) {
    let _ = transport.tx.send(message);
    if let Some(wake_write) = transport.wake_write {
        crate::fdutil::wake(wake_write);
    }
}

/// Drain all currently buffered messages from `transport` and drain the own
/// wake pipe so the next `loop.readable()` arms cleanly.
pub fn recv_messages(transport: &RecvTransport<'_>) -> Vec<ThreadMessage> {
    // Clear the signal before draining the queue. A concurrent send after the
    // drain then leaves its wake byte behind for the next readiness watch.
    if let Some(wake_read) = transport.wake_read {
        crate::fdutil::drain(wake_read);
    }
    let mut messages = Vec::new();
    while let Ok(message) = transport.rx.try_recv() {
        messages.push(message);
    }
    messages
}
