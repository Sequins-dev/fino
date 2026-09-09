//! Native I/O service. The host owns the driver; reactor threads submit work.

pub(crate) mod kernel;
#[cfg(target_os = "linux")]
mod uring;

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

const MAX_OPERATIONS: usize = 4096;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_RETAINED_BYTES: usize = 8 * 1024 * 1024;
pub(crate) static BUFFER_REUSES: AtomicU64 = AtomicU64::new(0);
pub(crate) const IO_TOKEN: u64 = 1 << 63;

enum Buffer {
    Read(v8::SharedRef<v8::BackingStore>),
    Write(v8::SharedRef<v8::BackingStore>),
    Writev {
        _stores: Vec<v8::SharedRef<v8::BackingStore>>,
        iov: Vec<libc::iovec>,
    },
}
// SAFETY: write backing stores have been detached from every JS view before
// publication. Reads have never been exposed to JS. Only the driver accesses
// bytes; ownership moves to the receiving isolate after the operation ends.
unsafe impl Send for Buffer {}

struct Operation {
    id: u64,
    owner: u32,
    original_fd: i32,
    fd: OwnedFd,
    buffer: Buffer,
    offset: usize,
    length: usize,
    progress: usize,
    charge: usize,
    regular: bool,
    in_flight: bool,
}
impl Operation {
    fn is_write(&self) -> bool {
        !matches!(self.buffer, Buffer::Read(_))
    }
    fn advance(&mut self, count: usize) {
        self.progress += count;
        if let Buffer::Writev { iov, .. } = &mut self.buffer {
            let mut remaining = count;
            let mut consumed = 0;
            for vector in iov.iter_mut() {
                if remaining < vector.iov_len {
                    vector.iov_base = unsafe { vector.iov_base.cast::<u8>().add(remaining).cast() };
                    vector.iov_len -= remaining;
                    break;
                }
                remaining -= vector.iov_len;
                consumed += 1;
            }
            iov.drain(..consumed);
        }
    }
    fn key(&self) -> (u32, i32, bool) {
        (
            self.owner,
            self.original_fd,
            !self.regular && self.is_write(),
        )
    }
    fn attempt(&mut self) -> Option<i64> {
        if self.length == 0 {
            return Some(0);
        }
        for _ in 0..16 {
            let n = match &mut self.buffer {
                Buffer::Read(bytes) => unsafe {
                    libc::read(
                        self.fd.as_raw_fd(),
                        bytes.data().unwrap().as_ptr(),
                        self.length,
                    )
                },
                Buffer::Write(store) => unsafe {
                    libc::write(
                        self.fd.as_raw_fd(),
                        store
                            .data()
                            .unwrap()
                            .as_ptr()
                            .cast::<u8>()
                            .add(self.offset + self.progress)
                            .cast(),
                        self.length - self.progress,
                    )
                },
                Buffer::Writev { iov, .. } => unsafe {
                    libc::writev(self.fd.as_raw_fd(), iov.as_ptr(), iov.len() as i32)
                },
            };
            if n >= 0 {
                if matches!(self.buffer, Buffer::Read(_)) {
                    return Some(n as i64);
                }
                if n == 0 {
                    return Some(-(libc::EIO as i64));
                }
                self.advance(n as usize);
                if self.progress == self.length {
                    return Some(self.progress as i64);
                }
            } else {
                let errno = std::io::Error::last_os_error()
                    .raw_os_error()
                    .unwrap_or(libc::EIO);
                if errno == libc::EINTR {
                    continue;
                }
                if errno == libc::EAGAIN || errno == libc::EWOULDBLOCK {
                    return None;
                }
                return Some(-(errno as i64));
            }
        }
        None
    }
}
struct Completion {
    operation: Operation,
    result: i64,
}
enum Command {
    Submit(Operation),
    Cancel(u32, u64),
    Retire(u32),
    Finished(Operation, i64),
}
#[derive(Default)]
struct Mail {
    commands: VecDeque<Command>,
    completions: HashMap<u32, Vec<Completion>>,
    operations: usize,
    bytes: usize,
    admitted: HashMap<u64, u32>,
    cancelled: HashSet<u64>,
    closed: bool,
    retained: Vec<Buffer>,
    retained_bytes: usize,
}
impl Mail {
    fn enqueue(&mut self, command: Command) -> bool {
        let notify = self.commands.is_empty();
        self.commands.push_back(command);
        notify
    }

    fn recycle(&mut self, store: v8::SharedRef<v8::BackingStore>) {
        let size = store.byte_length();
        if size == 0 || self.closed || size > MAX_RETAINED_BYTES {
            return;
        }
        while self.retained.len() >= 32 || size > MAX_RETAINED_BYTES - self.retained_bytes {
            let Buffer::Write(oldest) = self.retained.remove(0) else {
                unreachable!()
            };
            self.retained_bytes -= oldest.byte_length();
        }
        self.retained_bytes += size;
        self.retained.push(Buffer::Write(store));
    }
    fn read_buffer(&mut self, length: usize) -> Buffer {
        if let Some(index) = self.retained.iter().rposition(
            |buffer| matches!(buffer, Buffer::Write(store) if store.byte_length() == length),
        ) {
            let Buffer::Write(store) = self.retained.swap_remove(index) else {
                unreachable!()
            };
            self.retained_bytes -= length;
            // A short read must not expose the previous owner's unused bytes
            // through the returned view's ArrayBuffer.
            unsafe {
                store
                    .data()
                    .unwrap()
                    .as_ptr()
                    .cast::<u8>()
                    .write_bytes(0, length);
            }
            BUFFER_REUSES.fetch_add(1, Ordering::Relaxed);
            return Buffer::Read(store);
        }
        Buffer::Read(
            v8::ArrayBuffer::new_backing_store_from_bytes(vec![0; length].into_boxed_slice())
                .make_shared(),
        )
    }
}
fn mail() -> &'static Mutex<Mail> {
    static MAIL: OnceLock<Mutex<Mail>> = OnceLock::new();
    MAIL.get_or_init(Default::default)
}
fn release(mail: &mut Mail, operation: &Operation) {
    mail.admitted.remove(&operation.id);
    mail.cancelled.remove(&operation.id);
    mail.operations -= 1;
    mail.bytes -= operation.charge;
}
pub(crate) fn retire(owner: u32) {
    let mut mail = mail().lock().unwrap();
    let abandoned: Vec<_> = mail
        .admitted
        .iter()
        .filter(|(_, target)| **target == owner)
        .map(|(id, _)| *id)
        .collect();
    mail.cancelled.extend(abandoned);
    if let Some(completions) = mail.completions.remove(&owner) {
        for completion in completions {
            release(&mut mail, &completion.operation);
        }
    }
    let notify = mail.enqueue(Command::Retire(owner));
    drop(mail);
    if notify {
        crate::scheduler_native::notify_io();
    }
}

#[derive(Default)]
pub(crate) struct Engine {
    operations: BTreeMap<u64, Operation>,
    active: HashMap<(u32, i32, bool), u64>,
}
impl Drop for Engine {
    fn drop(&mut self) {
        let mut mail = mail().lock().unwrap();
        mail.closed = true;
        mail.retained.clear();
        mail.retained_bytes = 0;
        for operation in self.operations.values() {
            release(&mut mail, operation);
        }
        let commands = std::mem::take(&mut mail.commands);
        for command in commands {
            if let Command::Submit(operation) | Command::Finished(operation, _) = command {
                release(&mut mail, &operation);
            }
        }
        let completions = std::mem::take(&mut mail.completions);
        for completion in completions.into_values().flatten() {
            release(&mut mail, &completion.operation);
        }
    }
}
impl Engine {
    pub fn drain(&mut self, kernel: &mut kernel::Kernel) -> Result<(), String> {
        let commands = std::mem::take(&mut mail().lock().unwrap().commands);
        for command in commands {
            match command {
                Command::Submit(operation) => {
                    self.operations.insert(operation.id, operation);
                }
                Command::Finished(operation, result) => {
                    let id = operation.id;
                    self.operations.insert(id, operation);
                    let cancelled = mail().lock().unwrap().cancelled.contains(&id);
                    self.complete(
                        kernel,
                        id,
                        if cancelled {
                            -(libc::ECANCELED as i64)
                        } else {
                            result
                        },
                    );
                }
                Command::Cancel(owner, id) => {
                    if self.operations.get(&id).is_some_and(|op| op.owner == owner) {
                        if self.operations[&id].in_flight {
                            kernel.cancel_io(IO_TOKEN | id);
                        } else {
                            self.complete(kernel, id, -(libc::ECANCELED as i64));
                        }
                    }
                }
                Command::Retire(owner) => {
                    let ids: Vec<_> = self
                        .operations
                        .values()
                        .filter(|op| op.owner == owner)
                        .map(|op| op.id)
                        .collect();
                    for id in ids {
                        if self.operations[&id].in_flight {
                            kernel.cancel_io(IO_TOKEN | id);
                            continue;
                        }
                        if let Some(operation) = self.operations.remove(&id) {
                            kernel.remove(IO_TOKEN | id);
                            if self.active.get(&operation.key()) == Some(&id) {
                                self.active.remove(&operation.key());
                            }
                            release(&mut mail().lock().unwrap(), &operation);
                        }
                    }
                }
            }
        }
        let ids: Vec<_> = self.operations.keys().copied().collect();
        for id in ids {
            let op = self.operations.get(&id).unwrap();
            if self.active.contains_key(&op.key()) {
                continue;
            }
            self.active.insert(op.key(), id);
            self.progress(kernel, id)?;
        }
        Ok(())
    }
    fn complete(&mut self, kernel: &mut kernel::Kernel, id: u64, result: i64) {
        let Some(operation) = self.operations.remove(&id) else {
            return;
        };
        kernel.remove(IO_TOKEN | id);
        if self.active.get(&operation.key()) == Some(&id) {
            self.active.remove(&operation.key());
        }
        let owner = operation.owner;
        // Serialize retirement and publication through the owner registry.
        crate::scheduler_native::with_live_owner(owner, |alive| {
            let mut mail = mail().lock().unwrap();
            if alive {
                let completions = mail.completions.entry(owner).or_default();
                let notify = completions.is_empty();
                completions.push(Completion { operation, result });
                notify
            } else {
                release(&mut mail, &operation);
                false
            }
        });
    }
    pub fn progress(&mut self, kernel: &mut kernel::Kernel, id: u64) -> Result<(), String> {
        kernel.remove(IO_TOKEN | id);
        let Some(op) = self.operations.get_mut(&id) else {
            return Ok(());
        };
        if op.length == 0 {
            self.complete(kernel, id, 0);
            return Ok(());
        }
        if kernel.has_completion_io() {
            if let Buffer::Writev { iov, .. } = &op.buffer {
                unsafe {
                    kernel.submit_writev(
                        IO_TOKEN | id,
                        op.fd.as_raw_fd(),
                        iov.as_ptr(),
                        iov.len() as u32,
                    );
                }
                op.in_flight = true;
                return Ok(());
            }
            let (ptr, write) = match &mut op.buffer {
                Buffer::Read(bytes) => (
                    bytes
                        .data()
                        .map_or(std::ptr::null_mut(), |p| p.as_ptr().cast()),
                    false,
                ),
                Buffer::Write(store) => (
                    store.data().map_or(std::ptr::null_mut(), |p| unsafe {
                        p.as_ptr().cast::<u8>().add(op.offset + op.progress)
                    }),
                    true,
                ),
                Buffer::Writev { .. } => unreachable!(),
            };
            // The Operation owns fd and backing storage until its original CQE,
            // including after cancellation and Realm retirement.
            unsafe {
                kernel.submit_io(
                    IO_TOKEN | id,
                    op.fd.as_raw_fd(),
                    ptr,
                    (op.length - op.progress) as u32,
                    write,
                );
            }
            op.in_flight = true;
            return Ok(());
        }
        if op.regular {
            let mut operation = self.operations.remove(&id).unwrap();
            crate::async_rt::blocking::spawn(move || {
                let result = loop {
                    if mail().lock().unwrap().cancelled.contains(&id) {
                        break -(libc::ECANCELED as i64);
                    }
                    if let Some(result) = operation.attempt() {
                        break result;
                    }
                };
                let mut mail = mail().lock().unwrap();
                let notify = if mail.closed {
                    release(&mut mail, &operation);
                    false
                } else {
                    mail.enqueue(Command::Finished(operation, result))
                };
                drop(mail);
                if notify {
                    crate::scheduler_native::notify_io();
                }
            });
            return Ok(());
        }
        if let Some(result) = op.attempt() {
            self.complete(kernel, id, result);
        } else {
            let filter = if matches!(op.buffer, Buffer::Read(_)) {
                -1
            } else {
                -2
            };
            if let Err(error) = kernel.arm(IO_TOKEN | id, op.fd.as_raw_fd(), filter, 0) {
                self.complete(
                    kernel,
                    id,
                    -(error.raw_os_error().unwrap_or(libc::EIO) as i64),
                );
            }
        }
        Ok(())
    }

    pub fn completed(
        &mut self,
        kernel: &mut kernel::Kernel,
        id: u64,
        result: i64,
    ) -> Result<(), String> {
        let Some(op) = self.operations.get_mut(&id) else {
            return Ok(());
        };
        op.in_flight = false;
        if mail().lock().unwrap().cancelled.contains(&id) {
            self.complete(kernel, id, -(libc::ECANCELED as i64));
        } else if result > 0 && op.is_write() {
            op.advance(result as usize);
            if op.progress < op.length {
                return self.progress(kernel, id);
            }
            let total = op.progress as i64;
            self.complete(kernel, id, total);
        } else if result == -(libc::EINTR as i64) {
            return self.progress(kernel, id);
        } else {
            let result = if result == 0 && op.length > 0 && op.is_write() {
                -(libc::EIO as i64)
            } else {
                result
            };
            self.complete(kernel, id, result);
        }
        Ok(())
    }
}

pub(crate) fn submit(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let owner = crate::state::get_state(scope)
        .borrow()
        .scheduler_workload_owner;
    let fd = args.get(0).int32_value(scope).unwrap_or(-1);
    let write = args.get(1).is_uint8_array() || args.get(1).is_array();
    let mut array_buffers = Vec::new();
    let (buffer, offset, length, charge) = if args.get(1).is_array() {
        let vectors = v8::Local::<v8::Array>::try_from(args.get(1)).unwrap();
        if vectors.length() > 1024 {
            crate::v8util::throw_type_error(scope, "too many native I/O vectors");
            return;
        }
        let mut stores = Vec::new();
        let mut iov = Vec::new();
        let mut length = 0;
        let mut charge = 0;
        for index in 0..vectors.length() {
            let Some(value) = vectors.get_index(scope, index) else {
                return;
            };
            let Ok(view) = v8::Local::<v8::Uint8Array>::try_from(value) else {
                crate::v8util::throw_type_error(scope, "write vectors must be Uint8Arrays");
                return;
            };
            let Some(ab) = view.buffer(scope) else {
                return;
            };
            let store = ab.get_backing_store();
            if !ab.is_detachable()
                || ab.was_detached()
                || store.is_shared()
                || store.is_resizable_by_user_javascript()
            {
                crate::v8util::throw_type_error(
                    scope,
                    "write requires a detachable, fixed ArrayBuffer",
                );
                return;
            }
            if !array_buffers.contains(&ab) {
                charge += ab.byte_length();
                array_buffers.push(ab);
                stores.push(store.clone());
            }
            length += view.byte_length();
            if length > MAX_BYTES || charge > MAX_BYTES {
                crate::v8util::throw_error(scope, "native I/O admission limit exceeded");
                return;
            }
            if view.byte_length() > 0 {
                iov.push(libc::iovec {
                    iov_base: unsafe {
                        store
                            .data()
                            .unwrap()
                            .as_ptr()
                            .cast::<u8>()
                            .add(view.byte_offset())
                            .cast()
                    },
                    iov_len: view.byte_length(),
                });
            }
        }
        (
            Buffer::Writev {
                _stores: stores,
                iov,
            },
            0,
            length,
            charge,
        )
    } else if write {
        let view = v8::Local::<v8::Uint8Array>::try_from(args.get(1)).unwrap();
        let Some(ab) = view.buffer(scope) else {
            return;
        };
        let store = ab.get_backing_store();
        if !ab.is_detachable()
            || ab.was_detached()
            || store.is_shared()
            || store.is_resizable_by_user_javascript()
        {
            crate::v8util::throw_type_error(
                scope,
                "write requires a detachable, fixed ArrayBuffer",
            );
            return;
        }
        let values = (
            Buffer::Write(store),
            view.byte_offset(),
            view.byte_length(),
            ab.byte_length(),
        );
        array_buffers.push(ab);
        values
    } else {
        let length = args.get(1).number_value(scope).unwrap_or(-1.0);
        if !length.is_finite() || length < 0.0 || length.fract() != 0.0 || length > MAX_BYTES as f64
        {
            crate::v8util::throw_type_error(scope, "invalid native read capacity");
            return;
        }
        (
            Buffer::Writev {
                _stores: Vec::new(),
                iov: Vec::new(),
            },
            0,
            length as usize,
            length as usize,
        )
    };
    // Array element getters may have detached a previously inspected buffer.
    // Finish validation before detaching any member of the batch.
    if array_buffers
        .iter()
        .any(|ab| !ab.is_detachable() || ab.was_detached())
    {
        crate::v8util::throw_type_error(scope, "write requires a detachable, fixed ArrayBuffer");
        return;
    }
    let mut mail = mail().lock().unwrap();
    if mail.closed
        || owner == 0
        || mail.operations >= MAX_OPERATIONS
        || charge > MAX_BYTES.saturating_sub(mail.bytes)
    {
        crate::v8util::throw_error(scope, "native I/O admission limit exceeded");
        return;
    }
    let copied = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if copied < 0 {
        crate::v8util::throw_error(scope, "invalid I/O descriptor");
        return;
    }
    let owned = unsafe { OwnedFd::from_raw_fd(copied) };
    let flags = unsafe { libc::fcntl(copied, libc::F_GETFL) };
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    let regular = unsafe { libc::fstat(copied, &mut stat) } == 0
        && stat.st_mode & libc::S_IFMT == libc::S_IFREG;
    if flags < 0 || (!regular && flags & libc::O_NONBLOCK == 0) {
        crate::v8util::throw_error(scope, "native stream I/O requires a nonblocking descriptor");
        return;
    }
    let buffer = if write {
        buffer
    } else {
        mail.read_buffer(length)
    };
    for ab in array_buffers {
        if ab.detach(None) != Some(true) || !ab.was_detached() {
            crate::v8util::throw_error(scope, "buffer ownership transfer failed");
            return;
        }
    }
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    mail.operations += 1;
    mail.bytes += charge;
    mail.admitted.insert(id, owner);
    let notify = mail.enqueue(Command::Submit(Operation {
        id,
        owner,
        original_fd: fd,
        fd: owned,
        buffer,
        offset,
        length,
        progress: 0,
        charge,
        regular,
        in_flight: false,
    }));
    drop(mail);
    if notify {
        crate::scheduler_native::notify_io();
    }
    rv.set(v8::Number::new(scope, id as f64).into());
}

pub(crate) fn cancel(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let owner = crate::state::get_state(scope)
        .borrow()
        .scheduler_workload_owner;
    let id = args.get(0).number_value(scope).unwrap_or(0.0) as u64;
    let mut mail = mail().lock().unwrap();
    if mail.admitted.get(&id) != Some(&owner) || !mail.cancelled.insert(id) {
        return;
    }
    let notify = mail.enqueue(Command::Cancel(owner, id));
    drop(mail);
    if notify {
        crate::scheduler_native::notify_io();
    }
}

pub(crate) fn take(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let owner = crate::state::get_state(scope)
        .borrow()
        .scheduler_workload_owner;
    let completions = {
        let mut mail = mail().lock().unwrap();
        let completions = mail.completions.remove(&owner).unwrap_or_default();
        for completion in &completions {
            release(&mut mail, &completion.operation);
        }
        completions
    };
    let results = v8::Array::new(scope, (completions.len() * 3) as i32);
    let mut recycled = Vec::new();
    for (index, completion) in completions.into_iter().enumerate() {
        let id = v8::Number::new(scope, completion.operation.id as f64);
        let count = v8::Number::new(scope, completion.result as f64);
        let base = index as u32 * 3;
        results.set_index(scope, base, id.into());
        results.set_index(scope, base + 1, count.into());
        match completion.operation.buffer {
            Buffer::Read(store) => {
                let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
                let view = v8::Uint8Array::new(scope, buffer, 0, completion.result.max(0) as usize)
                    .unwrap();
                results.set_index(scope, base + 2, view.into());
            }
            Buffer::Write(store) => recycled.push(store),
            Buffer::Writev { _stores, .. } => {
                recycled.extend(_stores);
            }
        }
    }
    if !recycled.is_empty() {
        let mut mail = mail().lock().unwrap();
        for store in recycled {
            mail.recycle(store);
        }
    }
    rv.set(results.into());
}

fn blocking_i32(
    scope: &mut v8::PinScope,
    mut rv: v8::ReturnValue,
    label: &'static str,
    work: impl FnOnce() -> i32 + Send + 'static,
) {
    let Some(resolver) = v8::PromiseResolver::new(scope) else {
        return;
    };
    let promise = resolver.get_promise(scope);
    let Some((completions, _wake)) = crate::async_rt::completion_handle() else {
        crate::v8util::throw_error(scope, "native file operation requires an active runtime");
        return;
    };
    let resolver_id = crate::async_rt::push_resolver(v8::Global::new(scope, resolver));
    let owner = crate::state::get_state(scope)
        .borrow()
        .scheduler_workload_owner;
    let trace_id = crate::async_rt::diagnostics::begin(owner, "native-io", label);
    crate::async_rt::blocking::spawn(move || {
        crate::async_rt::diagnostics::stage(trace_id, "running");
        let value = work();
        crate::async_rt::diagnostics::stage(trace_id, "completion-queued");
        crate::scheduler_native::with_live_owner(owner, |alive| {
            if alive {
                let mut bytes = [0u8; 8];
                bytes[..4].copy_from_slice(&value.to_ne_bytes());
                let owned_fd =
                    (label == "open" && value >= 0).then(|| unsafe { OwnedFd::from_raw_fd(value) });
                completions
                    .lock()
                    .unwrap()
                    .push(crate::async_rt::FfiCompletion {
                        trace_id,
                        resolver_id,
                        result: Ok(crate::async_rt::RawFfiResult {
                            result_type: crate::ffi::types::NativeType::I32,
                            bytes,
                            aggregate: None,
                        }),
                        owned_fd,
                    });
                true
            } else if label == "open" && value >= 0 {
                unsafe { libc::close(value) };
                false
            } else {
                false
            }
        });
    });
    rv.set(promise.into());
}

pub(crate) fn open(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);
    // Match the existing cstr/libc behavior: the first embedded null ends the path.
    let path = std::ffi::CString::new(path.split('\0').next().unwrap()).unwrap();
    let flags = args.get(1).int32_value(scope).unwrap_or(0);
    let mode = args.get(2).uint32_value(scope).unwrap_or(0);
    blocking_i32(scope, rv, "open", move || {
        let result = unsafe { libc::open(path.as_ptr(), flags, mode) };
        if result >= 0 {
            result
        } else {
            -std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or(libc::EIO)
        }
    });
}

pub(crate) fn close(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    let fd = args.get(0).int32_value(scope).unwrap_or(-1);
    blocking_i32(scope, rv, "close", move || {
        let result = unsafe { libc::close(fd) };
        if result == 0 {
            0
        } else {
            -std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or(libc::EIO)
        }
    });
}

#[cfg(test)]
mod tests {
    use super::kernel::Kernel;
    use crate::fdutil::WakePipe;

    #[test]
    fn readiness_preserves_operation_identity_and_cancellation() {
        let pipe = WakePipe::new().unwrap();
        let mut kernel = Kernel::new().unwrap();
        kernel.arm(41, pipe.read_fd(), -1, 0).unwrap();
        pipe.notify();
        let events = kernel.wait(100).unwrap();
        assert!(events.iter().any(|event| event.token == 41));
        kernel.remove(41);
        assert!(kernel.wait(0).unwrap().is_empty());
        kernel.arm(42, pipe.read_fd(), -1, 0).unwrap();
        assert!(
            kernel
                .wait(100)
                .unwrap()
                .iter()
                .any(|event| event.token == 42)
        );
    }
    #[test]
    fn one_kernel_source_fans_out_without_losing_remaining_owners() {
        let pipe = WakePipe::new().unwrap();
        let mut kernel = Kernel::new().unwrap();
        kernel.arm(51, pipe.read_fd(), -1, 0).unwrap();
        kernel.arm(52, pipe.read_fd(), -1, 0).unwrap();
        pipe.notify();
        let events = kernel.wait(100).unwrap();
        assert!(events.iter().any(|event| event.token == 51));
        assert!(events.iter().any(|event| event.token == 52));
        pipe.drain();
        kernel.remove(51);
        pipe.notify();
        let events = kernel.wait(100).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].token, 52);
    }
}
