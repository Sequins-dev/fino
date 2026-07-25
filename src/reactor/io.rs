//! Shared Fino ownership layer over `cherenkov::Reactor`.
//!
//! Cherenkov owns submission, backend polling, cancellation, timers, and the
//! exactly-one-completion contract. This adapter owns only the state Cherenkov
//! deliberately leaves to its consumer: JS buffer retention, promise routing,
//! stable timer handles, and per-realm liveness accounting.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use cherenkov::{CURRENT_POS, Completion, Op, Reactor, Source, WatchId, err, fs_event};

/// The workload (engine id) that registered an operation.
pub(crate) type Owner = u64;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_read_supersedes_and_retains_the_previous_kernel_buffer() {
        let mut fds = [0; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let mut io = RuntimeIo::create().unwrap();
        let first = v8::ArrayBuffer::new_backing_store_from_vec(vec![0_u8; 8]).make_shared();
        let first_ptr = first.data().unwrap().as_ptr().cast::<u8>();
        io.submit_read(1, 1, first, fds[0], first_ptr, 8);
        let second = v8::ArrayBuffer::new_backing_store_from_vec(vec![0_u8; 8]).make_shared();
        let second_ptr = second.data().unwrap().as_ptr().cast::<u8>();

        io.submit_read(1, 2, second, fds[0], second_ptr, 8);

        assert_eq!(io.records.len(), 1);
        assert_eq!(io.doomed.len(), 1);
        unsafe {
            libc::close(fds[0]);
            libc::close(fds[1]);
        }
    }

    #[test]
    fn repoll_completion_is_routed_by_the_shared_record_registry() {
        let mut io = RuntimeIo::create().unwrap();
        let id = io.submit_repoll(7, 0);
        let mut completions = Vec::new();

        io.wait(Some(Duration::from_millis(100)), &mut completions)
            .unwrap();
        let completion = completions
            .into_iter()
            .find(|completion| completion.user_data == id)
            .expect("repoll completion");

        assert!(matches!(
            io.dispatch(completion.user_data, completion.res),
            Dispatch::Runnable { owner: 7 }
        ));
    }
}

pub(crate) struct Resolved {
    pub owner: Owner,
    pub resolver_id: usize,
    pub result: f64,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct Counts {
    pub reads: u32,
    pub writes: u32,
    pub timers: u32,
    pub procs: u32,
    pub vnodes: u32,
}

pub(crate) enum Transfer {
    Readiness {
        resolver_id: usize,
        fd: i32,
        read: bool,
        referenced: bool,
    },
    Timer {
        resolver_id: usize,
        timer_id: u64,
        deadline: Instant,
        referenced: bool,
    },
}

enum Record {
    Read {
        owner: Owner,
        resolver_id: usize,
        buffer: Option<v8::SharedRef<v8::BackingStore>>,
        fd: i32,
        ptr: *mut u8,
        len: u32,
        /// Unreferenced readiness watches (a realm's own port wake) never
        /// count toward liveness; fused reads are always referenced.
        referenced: bool,
    },
    Write {
        owner: Owner,
        resolver_id: usize,
        buffer: v8::SharedRef<v8::BackingStore>,
        fd: i32,
        base: u64,
        len: u32,
        done: u32,
    },
    Timer {
        owner: Owner,
        resolver_id: usize,
        timer_id: u64,
        deadline: Instant,
        referenced: bool,
    },
    Proc {
        owner: Owner,
        pid: u32,
        resolver_id: usize,
    },
    VnodeNext {
        owner: Owner,
        fd: i32,
        watch: WatchId,
    },
    SignalNext {
        owner: Owner,
        signo: i32,
        watch: WatchId,
    },
    RePoll {
        owner: Owner,
    },
    WakeSource {
        owner: Owner,
        fd: i32,
    },
}

impl Record {
    fn owner(&self) -> Owner {
        match self {
            Self::Read { owner, .. }
            | Self::Write { owner, .. }
            | Self::Timer { owner, .. }
            | Self::Proc { owner, .. }
            | Self::VnodeNext { owner, .. }
            | Self::SignalNext { owner, .. }
            | Self::RePoll { owner }
            | Self::WakeSource { owner, .. } => *owner,
        }
    }

    fn retains_kernel_pointer(&self) -> bool {
        matches!(
            self,
            Self::Read {
                buffer: Some(_),
                ..
            } | Self::Write { .. }
        )
    }
}

struct VnodeEntry {
    owner: Owner,
    watch: WatchId,
    path: std::path::PathBuf,
    callback_id: usize,
}

struct SignalEntry {
    owner: Owner,
    watch: WatchId,
    callback_id: usize,
}

/// Completion result after the adapter has applied continuation bookkeeping.
pub(crate) enum Dispatch {
    /// A common op completed but intentionally resolves nothing (cancellation).
    Handled,
    /// Settle this promise in its owning isolate.
    Resolved(Resolved),
    /// Run a registered callback in its owning isolate.
    Callback {
        owner: Owner,
        callback_id: usize,
        fflags: Option<u32>,
    },
    /// A repoll timer or wake source made its owner runnable.
    Runnable { owner: Owner },
}

pub(crate) struct RuntimeIo {
    reactor: Reactor,
    next_id: u64,
    records: HashMap<u64, Record>,
    doomed: HashMap<u64, Record>,
    reads: HashMap<i32, u64>,
    writes: HashMap<i32, u64>,
    timers: HashMap<u64, u64>,
    vnodes: HashMap<(Owner, i32), VnodeEntry>,
    signals: HashMap<(Owner, i32), SignalEntry>,
}

impl RuntimeIo {
    pub fn new(reactor: Reactor) -> Self {
        Self {
            reactor,
            next_id: 1,
            records: HashMap::new(),
            doomed: HashMap::new(),
            reads: HashMap::new(),
            writes: HashMap::new(),
            timers: HashMap::new(),
            vnodes: HashMap::new(),
            signals: HashMap::new(),
        }
    }

    #[cfg(test)]
    pub fn create() -> std::io::Result<Self> {
        Reactor::new().map(Self::new)
    }

    pub fn notifier(&self) -> cherenkov::Notifier {
        self.reactor.notifier()
    }

    pub fn pending(&self) -> usize {
        self.reactor.pending()
    }

    pub fn wait(
        &mut self,
        timeout: Option<Duration>,
        completions: &mut Vec<Completion>,
    ) -> std::io::Result<usize> {
        self.reactor.wait(timeout, completions)
    }

    /// Cancel every adapter-owned operation before replacing a failed
    /// thread's completion reactor. Records remain intact: canceled
    /// operations are re-armed on the replacement, while operations whose
    /// real completion won the race are dispatched before the swap.
    pub fn cancel_all(&mut self) {
        for id in self.records.keys().copied().collect::<Vec<_>>() {
            self.reactor.cancel(id);
        }
        for id in self.doomed.keys().copied().collect::<Vec<_>>() {
            self.reactor.cancel(id);
        }
    }

    pub fn is_live_record(&self, id: u64) -> bool {
        self.records.contains_key(&id)
    }

    /// Replace the physical completion reactor and re-arm every operation
    /// that was canceled solely for thread recovery. The old backend is
    /// dropped before any pointer-carrying operation is submitted again.
    pub fn replace_reactor(&mut self, reactor: Reactor) {
        let old = std::mem::replace(&mut self.reactor, reactor);
        drop(old);
        self.doomed.clear();

        let mut invalid_vnodes = Vec::new();
        for (key, entry) in &mut self.vnodes {
            match self.reactor.add_fs_watch(&entry.path, fs_event::ALL) {
                Ok(watch) => entry.watch = watch,
                Err(_) => invalid_vnodes.push(*key),
            }
        }
        for key in invalid_vnodes {
            if let Some(entry) = self.vnodes.remove(&key) {
                crate::async_rt::js_calls::unregister_callback(entry.callback_id);
            }
            self.records.retain(|_, record| {
                !matches!(record, Record::VnodeNext { owner, fd, .. } if (*owner, *fd) == key)
            });
        }
        let mut invalid_signals = Vec::new();
        for (key, entry) in &mut self.signals {
            match self.reactor.add_signal_watch(key.1) {
                Ok(watch) => entry.watch = watch,
                Err(_) => invalid_signals.push(*key),
            }
        }
        for key in invalid_signals {
            if let Some(entry) = self.signals.remove(&key) {
                crate::async_rt::js_calls::unregister_callback(entry.callback_id);
            }
            self.records.retain(|_, record| {
                !matches!(record, Record::SignalNext { owner, signo, .. } if (*owner, *signo) == key)
            });
        }

        // Writes re-arm through `arm_write_op`, which needs `&mut self`;
        // collect them while the records are borrowed.
        let mut writes: Vec<(u64, i32, u64, u32, u32)> = Vec::new();
        for (&id, record) in &mut self.records {
            match record {
                Record::Read {
                    buffer,
                    fd,
                    ptr,
                    len,
                    ..
                } => {
                    if buffer.is_some() {
                        unsafe {
                            self.reactor.submit(
                                id,
                                Op::Read {
                                    src: Source::fd(*fd),
                                    buf: *ptr,
                                    len: *len,
                                    off: CURRENT_POS,
                                },
                            );
                        }
                    } else if self.reads.get(fd) == Some(&id) {
                        self.reactor.submit_poll_in(id, Source::fd(*fd));
                    } else {
                        self.reactor.submit_poll_out(id, Source::fd(*fd));
                    }
                }
                Record::Write {
                    fd,
                    base,
                    len,
                    done,
                    ..
                } => writes.push((id, *fd, *base, *len, *done)),
                Record::Timer { deadline, .. } => self.reactor.submit_timeout(
                    id,
                    deadline
                        .saturating_duration_since(Instant::now())
                        .as_millis() as u64,
                ),
                Record::Proc { pid, .. } => self.reactor.submit_proc_exit(id, *pid),
                Record::VnodeNext {
                    owner, fd, watch, ..
                } => {
                    if let Some(entry) = self.vnodes.get(&(*owner, *fd)) {
                        *watch = entry.watch;
                        self.reactor.submit_watch_next(id, entry.watch);
                    }
                }
                Record::SignalNext {
                    owner,
                    signo,
                    watch,
                } => {
                    if let Some(entry) = self.signals.get(&(*owner, *signo)) {
                        *watch = entry.watch;
                        self.reactor.submit_watch_next(id, entry.watch);
                    }
                }
                Record::RePoll { .. } => self.reactor.submit_timeout(id, 25),
                Record::WakeSource { fd, .. } => self.reactor.submit_poll_in(id, Source::fd(*fd)),
            }
        }
        for (id, fd, base, len, done) in writes {
            self.arm_write_op(id, fd, base, len, done);
        }
    }

    /// Arm (or re-arm) the remaining bytes of a tracked write.
    ///
    /// SAFETY: the caller's record retains the backing store covering
    /// `base..base+len` until the completion is harvested.
    fn arm_write_op(&mut self, id: u64, fd: i32, base: u64, len: u32, done: u32) {
        unsafe {
            self.reactor.submit(
                id,
                Op::Write {
                    src: Source::fd(fd),
                    buf: (base + done as u64) as *const u8,
                    len: len - done,
                    off: CURRENT_POS,
                },
            );
        }
    }

    pub fn submit_readiness(
        &mut self,
        owner: Owner,
        resolver_id: usize,
        fd: i32,
        read: bool,
        referenced: bool,
    ) {
        self.remove_fd(fd, read);
        let id = self.next_id();
        if read {
            self.reactor.submit_poll_in(id, Source::fd(fd));
            self.reads.insert(fd, id);
        } else {
            self.reactor.submit_poll_out(id, Source::fd(fd));
            self.writes.insert(fd, id);
        }
        self.records.insert(
            id,
            Record::Read {
                owner,
                resolver_id,
                buffer: None,
                fd,
                ptr: std::ptr::null_mut(),
                len: 0,
                referenced,
            },
        );
    }

    pub fn submit_read(
        &mut self,
        owner: Owner,
        resolver_id: usize,
        buffer: v8::SharedRef<v8::BackingStore>,
        fd: i32,
        ptr: *mut u8,
        len: usize,
    ) {
        self.remove_fd(fd, true);
        let id = self.next_id();
        unsafe {
            self.reactor.submit(
                id,
                Op::Read {
                    src: Source::fd(fd),
                    buf: ptr,
                    len: len as u32,
                    off: CURRENT_POS,
                },
            );
        }
        self.reads.insert(fd, id);
        self.records.insert(
            id,
            Record::Read {
                owner,
                resolver_id,
                buffer: Some(buffer),
                fd,
                ptr,
                len: len as u32,
                referenced: true,
            },
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub fn submit_write(
        &mut self,
        owner: Owner,
        resolver_id: usize,
        buffer: v8::SharedRef<v8::BackingStore>,
        fd: i32,
        base: *mut u8,
        len: usize,
        done: usize,
    ) {
        self.remove_fd(fd, false);
        let id = self.next_id();
        let base = base as u64;
        let len = len as u32;
        let done = done as u32;
        self.arm_write_op(id, fd, base, len, done);
        self.writes.insert(fd, id);
        self.records.insert(
            id,
            Record::Write {
                owner,
                resolver_id,
                buffer,
                fd,
                base,
                len,
                done,
            },
        );
    }

    pub fn submit_timer(
        &mut self,
        owner: Owner,
        resolver_id: usize,
        timer_id: u64,
        ms: u64,
        referenced: bool,
    ) {
        let id = self.next_id();
        self.reactor.submit_timeout(id, ms);
        self.records.insert(
            id,
            Record::Timer {
                owner,
                resolver_id,
                timer_id,
                deadline: Instant::now() + Duration::from_millis(ms),
                referenced,
            },
        );
        self.timers.insert(timer_id, id);
    }

    pub fn submit_proc(&mut self, owner: Owner, pid: u32, resolver_id: usize) {
        let id = self.next_id();
        self.reactor.submit_proc_exit(id, pid);
        self.records.insert(
            id,
            Record::Proc {
                owner,
                pid,
                resolver_id,
            },
        );
    }

    pub fn submit_repoll(&mut self, owner: Owner, ms: u64) -> u64 {
        let id = self.next_id();
        self.reactor.submit_timeout(id, ms);
        self.records.insert(id, Record::RePoll { owner });
        id
    }

    pub fn add_vnode(
        &mut self,
        owner: Owner,
        fd: i32,
        path: std::path::PathBuf,
        callback_id: usize,
    ) {
        self.remove_vnode(owner, fd);
        let Ok(watch) = self.reactor.add_fs_watch(&path, fs_event::ALL) else {
            crate::async_rt::js_calls::unregister_callback(callback_id);
            return;
        };
        self.arm_vnode(owner, fd, watch);
        self.vnodes.insert(
            (owner, fd),
            VnodeEntry {
                owner,
                watch,
                path,
                callback_id,
            },
        );
    }

    pub fn remove_vnode(&mut self, owner: Owner, fd: i32) {
        if let Some(entry) = self.vnodes.remove(&(owner, fd)) {
            let _ = self.reactor.remove_watch(entry.watch);
            crate::async_rt::js_calls::unregister_callback(entry.callback_id);
        }
    }

    fn arm_vnode(&mut self, owner: Owner, fd: i32, watch: WatchId) {
        let id = self.next_id();
        self.reactor.submit_watch_next(id, watch);
        self.records
            .insert(id, Record::VnodeNext { owner, fd, watch });
    }

    pub fn add_signal(&mut self, owner: Owner, signo: i32, callback_id: usize) {
        self.remove_signal(owner, signo);
        let Ok(watch) = self.reactor.add_signal_watch(signo) else {
            crate::async_rt::js_calls::unregister_callback(callback_id);
            return;
        };
        self.arm_signal(owner, signo, watch);
        self.signals.insert(
            (owner, signo),
            SignalEntry {
                owner,
                watch,
                callback_id,
            },
        );
    }

    pub fn remove_signal(&mut self, owner: Owner, signo: i32) {
        if let Some(entry) = self.signals.remove(&(owner, signo)) {
            let _ = self.reactor.remove_watch(entry.watch);
            crate::async_rt::js_calls::unregister_callback(entry.callback_id);
        }
    }

    fn arm_signal(&mut self, owner: Owner, signo: i32, watch: WatchId) {
        let id = self.next_id();
        self.reactor.submit_watch_next(id, watch);
        self.records.insert(
            id,
            Record::SignalNext {
                owner,
                signo,
                watch,
            },
        );
    }

    pub fn register_wake_source(&mut self, owner: Owner, fd: i32) {
        let id = self.next_id();
        self.reactor.submit_poll_in(id, Source::fd(fd));
        self.records.insert(id, Record::WakeSource { owner, fd });
    }

    pub fn cancel_timer(&mut self, timer_id: u64) {
        if let Some(id) = self.timers.remove(&timer_id) {
            self.reactor.cancel(id);
            self.records.remove(&id);
        }
    }

    pub fn set_timer_ref(&mut self, timer_id: u64, referenced: bool) {
        let Some(id) = self.timers.get(&timer_id) else {
            return;
        };
        if let Some(Record::Timer {
            referenced: current,
            ..
        }) = self.records.get_mut(id)
        {
            *current = referenced;
        }
    }

    pub fn remove_read(&mut self, fd: i32) {
        self.remove_fd(fd, true);
    }

    pub fn remove_write(&mut self, fd: i32) {
        self.remove_fd(fd, false);
    }

    fn remove_fd(&mut self, fd: i32, read: bool) {
        let index = if read {
            &mut self.reads
        } else {
            &mut self.writes
        };
        let Some(id) = index.remove(&fd) else { return };
        self.reactor.cancel(id);
        if let Some(record) = self.records.remove(&id)
            && record.retains_kernel_pointer()
        {
            self.doomed.insert(id, record);
        }
    }

    pub fn dispatch(&mut self, id: u64, res: i32) -> Dispatch {
        if self.doomed.remove(&id).is_some() {
            return Dispatch::Handled;
        }
        let Some(record) = self.records.remove(&id) else {
            return Dispatch::Handled;
        };
        match record {
            Record::Read {
                owner,
                resolver_id,
                buffer,
                fd,
                ptr,
                len,
                referenced: _,
            } => {
                if res == -libc::EAGAIN
                    && let Some(buffer) = buffer
                {
                    self.submit_read(owner, resolver_id, buffer, fd, ptr, len as usize);
                    return Dispatch::Handled;
                }
                self.unindex(fd, id, true);
                Dispatch::Resolved(Resolved {
                    owner,
                    resolver_id,
                    result: res as f64,
                })
            }
            Record::Write {
                owner,
                resolver_id,
                buffer,
                fd,
                base,
                len,
                done,
            } => {
                if res == -libc::EAGAIN {
                    self.resubmit_write(owner, resolver_id, buffer, fd, base, len, done);
                    return Dispatch::Handled;
                }
                if res < 0 {
                    self.unindex(fd, id, false);
                    return Dispatch::Resolved(Resolved {
                        owner,
                        resolver_id,
                        result: res as f64,
                    });
                }
                let done = done + res as u32;
                if done >= len {
                    self.unindex(fd, id, false);
                    Dispatch::Resolved(Resolved {
                        owner,
                        resolver_id,
                        result: done as f64,
                    })
                } else {
                    self.resubmit_write(owner, resolver_id, buffer, fd, base, len, done);
                    Dispatch::Handled
                }
            }
            Record::Timer {
                owner,
                resolver_id,
                timer_id,
                ..
            } => {
                self.timers.remove(&timer_id);
                Dispatch::Resolved(Resolved {
                    owner,
                    resolver_id,
                    result: 0.0,
                })
            }
            Record::Proc {
                owner, resolver_id, ..
            } => Dispatch::Resolved(Resolved {
                owner,
                resolver_id,
                result: 0.0,
            }),
            Record::VnodeNext { owner, fd, watch } => {
                if res == err::CANCELED || res == err::BUSY {
                    return Dispatch::Handled;
                }
                let live = self
                    .vnodes
                    .get(&(owner, fd))
                    .is_some_and(|entry| entry.watch == watch);
                if !live {
                    return Dispatch::Handled;
                }
                if res < 0 {
                    self.vnodes.remove(&(owner, fd));
                    return Dispatch::Handled;
                }
                let callback_id = self.vnodes[&(owner, fd)].callback_id;
                self.arm_vnode(owner, fd, watch);
                Dispatch::Callback {
                    owner,
                    callback_id,
                    fflags: Some(super::imp::fs_to_note(res)),
                }
            }
            Record::SignalNext {
                owner,
                signo,
                watch,
            } => {
                let live = self
                    .signals
                    .get(&(owner, signo))
                    .is_some_and(|entry| entry.watch == watch);
                if res < 0 {
                    if live && res != err::CANCELED && res != err::BUSY {
                        self.signals.remove(&(owner, signo));
                    }
                    return Dispatch::Handled;
                }
                if !live {
                    return Dispatch::Handled;
                }
                let callback_id = self.signals[&(owner, signo)].callback_id;
                self.arm_signal(owner, signo, watch);
                Dispatch::Callback {
                    owner,
                    callback_id,
                    fflags: None,
                }
            }
            Record::RePoll { owner } => Dispatch::Runnable { owner },
            Record::WakeSource { owner, fd } => {
                if res < 0 {
                    return Dispatch::Handled;
                }
                let mut buf = [0u8; 64];
                let eof = loop {
                    let n = unsafe {
                        libc::read(fd, buf.as_mut_ptr() as *mut std::ffi::c_void, buf.len())
                    };
                    if n == 0 {
                        break true;
                    }
                    if n < 0 {
                        break false;
                    }
                };
                if !eof {
                    self.register_wake_source(owner, fd);
                }
                Dispatch::Runnable { owner }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn resubmit_write(
        &mut self,
        owner: Owner,
        resolver_id: usize,
        buffer: v8::SharedRef<v8::BackingStore>,
        fd: i32,
        base: u64,
        len: u32,
        done: u32,
    ) {
        let id = self.next_id();
        self.arm_write_op(id, fd, base, len, done);
        self.writes.insert(fd, id);
        self.records.insert(
            id,
            Record::Write {
                owner,
                resolver_id,
                buffer,
                fd,
                base,
                len,
                done,
            },
        );
    }

    fn unindex(&mut self, fd: i32, id: u64, read: bool) {
        let index = if read {
            &mut self.reads
        } else {
            &mut self.writes
        };
        if index.get(&fd) == Some(&id) {
            index.remove(&fd);
        }
    }

    pub fn counts(&self, owner: Owner) -> Counts {
        let mut counts = Counts::default();
        for record in self.records.values() {
            if record.owner() != owner {
                continue;
            }
            match record {
                Record::Read {
                    referenced: false, ..
                } => {}
                Record::Read { .. } => counts.reads += 1,
                Record::Write { .. } => counts.writes += 1,
                Record::Timer {
                    referenced: true, ..
                } => counts.timers += 1,
                Record::Timer { .. } => {}
                Record::Proc { .. } => counts.procs += 1,
                Record::VnodeNext { .. } => {}
                Record::SignalNext { .. } | Record::RePoll { .. } | Record::WakeSource { .. } => {}
            }
        }
        counts.vnodes = self
            .vnodes
            .values()
            .filter(|entry| entry.owner == owner)
            .count() as u32;
        counts
    }

    pub fn cancel_owner(&mut self, owner: Owner) {
        let ids: Vec<u64> = self
            .records
            .iter()
            .filter_map(|(id, record)| (record.owner() == owner).then_some(*id))
            .collect();
        for id in ids {
            self.reactor.cancel(id);
            let record = self.records.remove(&id).unwrap();
            if record.retains_kernel_pointer() {
                self.doomed.insert(id, record);
            }
        }
        self.timers.retain(|_, id| self.records.contains_key(id));
        self.reads.retain(|_, id| self.records.contains_key(id));
        self.writes.retain(|_, id| self.records.contains_key(id));
        let vnode_keys: Vec<_> = self
            .vnodes
            .iter()
            .filter_map(|(key, entry)| (entry.owner == owner).then_some(*key))
            .collect();
        for key in vnode_keys {
            if let Some(entry) = self.vnodes.remove(&key) {
                let _ = self.reactor.remove_watch(entry.watch);
            }
        }
        let signal_keys: Vec<_> = self
            .signals
            .iter()
            .filter_map(|(key, entry)| (entry.owner == owner).then_some(*key))
            .collect();
        for key in signal_keys {
            if let Some(entry) = self.signals.remove(&key) {
                let _ = self.reactor.remove_watch(entry.watch);
            }
        }
    }

    pub fn doomed_is_empty(&self) -> bool {
        self.doomed.is_empty()
    }

    pub fn doomed_len(&self) -> usize {
        self.doomed.len()
    }

    pub fn discard_doomed(&mut self) {
        self.doomed.clear();
    }

    pub fn has_owner(&self, owner: Owner) -> bool {
        self.records.values().any(|record| record.owner() == owner)
            || self.doomed.values().any(|record| record.owner() == owner)
    }

    pub fn has_unmovable(&self, owner: Owner) -> bool {
        self.records.values().any(|record| {
            record.owner() == owner
                && matches!(
                    record,
                    Record::Proc { .. }
                        | Record::VnodeNext { .. }
                        | Record::SignalNext { .. }
                        | Record::RePoll { .. }
                        | Record::WakeSource { .. }
                )
        })
    }

    pub fn detach_workload(&mut self, owner: u64) -> Vec<Transfer> {
        let ids: Vec<u64> = self
            .records
            .iter()
            .filter_map(|(id, record)| match record {
                Record::Read {
                    owner: record_owner,
                    buffer: None,
                    ..
                }
                | Record::Timer {
                    owner: record_owner,
                    ..
                } if *record_owner == owner => Some(*id),
                _ => None,
            })
            .collect();
        let mut transfers = Vec::with_capacity(ids.len());
        for id in ids {
            self.reactor.cancel(id);
            let Some(record) = self.records.remove(&id) else {
                continue;
            };
            match record {
                Record::Read {
                    resolver_id,
                    fd,
                    referenced,
                    ..
                } => {
                    let read = self.reads.get(&fd) == Some(&id);
                    if read {
                        self.reads.remove(&fd);
                    } else if self.writes.get(&fd) == Some(&id) {
                        self.writes.remove(&fd);
                    }
                    transfers.push(Transfer::Readiness {
                        resolver_id,
                        fd,
                        read,
                        referenced,
                    });
                }
                Record::Timer {
                    resolver_id,
                    timer_id,
                    deadline,
                    referenced,
                    ..
                } => {
                    self.timers.remove(&timer_id);
                    transfers.push(Transfer::Timer {
                        resolver_id,
                        timer_id,
                        deadline,
                        referenced,
                    });
                }
                _ => unreachable!(),
            }
        }
        transfers
    }

    pub fn attach_workload(&mut self, owner: u64, transfers: Vec<Transfer>) {
        for transfer in transfers {
            match transfer {
                Transfer::Readiness {
                    resolver_id,
                    fd,
                    read,
                    referenced,
                } => self.submit_readiness(owner, resolver_id, fd, read, referenced),
                Transfer::Timer {
                    resolver_id,
                    timer_id,
                    deadline,
                    referenced,
                } => self.submit_timer(
                    owner,
                    resolver_id,
                    timer_id,
                    deadline
                        .saturating_duration_since(Instant::now())
                        .as_millis() as u64,
                    referenced,
                ),
            }
        }
    }

    fn next_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }
}
