//! Native I/O service. The host owns the driver; reactor threads submit work.

pub(crate) mod kernel;

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

const MAX_OPERATIONS: usize = 4096;
const MAX_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const IO_TOKEN: u64 = 1 << 63;

enum Buffer {
    Read(Box<[u8]>),
    Write(v8::SharedRef<v8::BackingStore>),
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
}
impl Operation {
    fn key(&self) -> (u32, i32, bool) {
        (
            self.owner,
            self.original_fd,
            !self.regular && matches!(self.buffer, Buffer::Write(_)),
        )
    }
    fn attempt(&mut self) -> Option<i64> {
        if self.length == 0 {
            return Some(0);
        }
        for _ in 0..16 {
            let n = match &mut self.buffer {
                Buffer::Read(bytes) => unsafe {
                    libc::read(self.fd.as_raw_fd(), bytes.as_mut_ptr().cast(), self.length)
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
            };
            if n >= 0 {
                if matches!(self.buffer, Buffer::Read(_)) {
                    return Some(n as i64);
                }
                if n == 0 {
                    return Some(-(libc::EIO as i64));
                }
                self.progress += n as usize;
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
    mail.commands.push_back(Command::Retire(owner));
    drop(mail);
    crate::scheduler_native::notify_io();
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
                        self.complete(kernel, id, -(libc::ECANCELED as i64));
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
                mail.completions
                    .entry(owner)
                    .or_default()
                    .push(Completion { operation, result });
            } else {
                release(&mut mail, &operation);
            }
        });
    }
    pub fn progress(&mut self, kernel: &mut kernel::Kernel, id: u64) -> Result<(), String> {
        kernel.remove(IO_TOKEN | id);
        let Some(op) = self.operations.get_mut(&id) else {
            return Ok(());
        };
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
                if mail.closed {
                    release(&mut mail, &operation);
                } else {
                    mail.commands
                        .push_back(Command::Finished(operation, result));
                }
                drop(mail);
                crate::scheduler_native::notify_io();
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
    let write = args.get(1).is_uint8_array();
    let mut array_buffer = None;
    let (buffer, offset, length, charge) = if write {
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
        array_buffer = Some(ab);
        values
    } else {
        let length = args.get(1).number_value(scope).unwrap_or(-1.0);
        if !length.is_finite() || length < 0.0 || length.fract() != 0.0 || length > MAX_BYTES as f64
        {
            crate::v8util::throw_type_error(scope, "invalid native read capacity");
            return;
        }
        (
            Buffer::Read(Vec::new().into_boxed_slice()),
            0,
            length as usize,
            length as usize,
        )
    };
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
        Buffer::Read(vec![0; length].into_boxed_slice())
    };
    if let Some(ab) = array_buffer {
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
    mail.commands.push_back(Command::Submit(Operation {
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
    }));
    drop(mail);
    crate::scheduler_native::notify_io();
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
    mail.commands.push_back(Command::Cancel(owner, id));
    drop(mail);
    crate::scheduler_native::notify_io();
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
    let results = v8::Array::new(scope, completions.len() as i32);
    for (index, completion) in completions.into_iter().enumerate() {
        let result = v8::Array::new(scope, 3);
        let id = v8::Number::new(scope, completion.operation.id as f64);
        let count = v8::Number::new(scope, completion.result as f64);
        result.set_index(scope, 0, id.into());
        result.set_index(scope, 1, count.into());
        if let Buffer::Read(bytes) = completion.operation.buffer {
            let store = v8::ArrayBuffer::new_backing_store_from_bytes(bytes).make_shared();
            let buffer = v8::ArrayBuffer::with_backing_store(scope, &store);
            let view =
                v8::Uint8Array::new(scope, buffer, 0, completion.result.max(0) as usize).unwrap();
            result.set_index(scope, 2, view.into());
        }
        results.set_index(scope, index as u32, result.into());
    }
    rv.set(results.into());
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
