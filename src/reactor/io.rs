//! Shared Fino ownership layer over `cherenkov::Reactor`.
//!
//! Cherenkov owns submission, backend polling, cancellation, timers, and the
//! exactly-one-completion contract. This adapter owns only the state Cherenkov
//! deliberately leaves to its consumer: JS buffer retention, promise routing,
//! stable timer handles, and per-realm liveness accounting.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use cherenkov::{CURRENT_POS, Completion, Op, Reactor, Source};

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
        io.submit_read(
            1,
            Target {
                id: 1,
                resolver_id: 1,
            },
            first,
            fds[0],
            first_ptr,
            8,
        );
        let second = v8::ArrayBuffer::new_backing_store_from_vec(vec![0_u8; 8]).make_shared();
        let second_ptr = second.data().unwrap().as_ptr().cast::<u8>();

        io.submit_read(
            1,
            Target {
                id: 1,
                resolver_id: 2,
            },
            second,
            fds[0],
            second_ptr,
            8,
        );

        assert_eq!(io.records.len(), 1);
        assert_eq!(io.doomed.len(), 1);
        unsafe {
            libc::close(fds[0]);
            libc::close(fds[1]);
        }
    }
}

/// Where a completion resolves: a resolver slot in the owning workload.
#[derive(Clone, Copy)]
pub(crate) struct Target {
    pub id: u64,
    pub resolver_id: usize,
}

pub(crate) struct Resolved {
    pub target: Target,
    pub result: f64,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct Counts {
    pub reads: u32,
    pub writes: u32,
    pub timers: u32,
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
        target: Target,
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
        target: Target,
        buffer: v8::SharedRef<v8::BackingStore>,
        fd: i32,
        base: u64,
        len: u32,
        done: u32,
    },
    Timer {
        owner: Owner,
        target: Target,
        timer_id: u64,
        deadline: Instant,
        referenced: bool,
    },
}

impl Record {
    fn owner(&self) -> Owner {
        match self {
            Self::Read { owner, .. } | Self::Write { owner, .. } | Self::Timer { owner, .. } => {
                *owner
            }
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

/// Completion result after the adapter has applied continuation bookkeeping.
pub(crate) enum Dispatch {
    /// The completion belonged to a caller-managed operation.
    External,
    /// A common op completed but intentionally resolves nothing (cancellation).
    Handled,
    /// Settle this promise in its owning isolate.
    Resolved(Resolved),
}

pub(crate) struct RuntimeIo {
    reactor: Reactor,
    next_id: u64,
    records: HashMap<u64, Record>,
    doomed: HashMap<u64, Record>,
    reads: HashMap<i32, u64>,
    writes: HashMap<i32, u64>,
    timers: HashMap<u64, u64>,
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

    /// Allocate a tag for a caller-managed operation sharing this reactor.
    pub fn next_external_id(&mut self) -> u64 {
        self.next_id()
    }

    pub fn submit_external(&mut self, id: u64, op: Op) {
        // SAFETY: callers of this internal adapter retain every pointer carried
        // by an external operation until its completion is harvested.
        unsafe { self.reactor.submit(id, op) }
    }

    pub fn submit_proc_exit(&mut self, id: u64, pid: u32) {
        self.reactor.submit_proc_exit(id, pid);
    }

    pub fn submit_watch_next(&mut self, id: u64, watch: cherenkov::WatchId) {
        self.reactor.submit_watch_next(id, watch);
    }

    pub fn submit_external_timeout(&mut self, id: u64, ms: u64) {
        self.reactor.submit_timeout(id, ms);
    }

    pub fn add_fs_watch(
        &mut self,
        path: &std::path::Path,
        mask: i32,
    ) -> std::io::Result<cherenkov::WatchId> {
        self.reactor.add_fs_watch(path, mask)
    }

    pub fn add_signal_watch(&mut self, signo: i32) -> std::io::Result<cherenkov::WatchId> {
        self.reactor.add_signal_watch(signo)
    }

    pub fn remove_kernel_watch(&mut self, watch: cherenkov::WatchId) -> std::io::Result<()> {
        self.reactor.remove_watch(watch)
    }

    pub fn cancel_external(&mut self, id: u64) {
        self.reactor.cancel(id);
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

        // Writes re-arm through `arm_write_op`, which needs `&mut self`;
        // collect them while the records are borrowed.
        let mut writes: Vec<(u64, i32, u64, u32, u32)> = Vec::new();
        for (&id, record) in &self.records {
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
        target: Target,
        fd: i32,
        read: bool,
        referenced: bool,
    ) {
        self.supersede_fd(fd, read);
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
                target,
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
        target: Target,
        buffer: v8::SharedRef<v8::BackingStore>,
        fd: i32,
        ptr: *mut u8,
        len: usize,
    ) {
        self.supersede_fd(fd, true);
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
                target,
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
        target: Target,
        buffer: v8::SharedRef<v8::BackingStore>,
        fd: i32,
        base: *mut u8,
        len: usize,
        done: usize,
    ) {
        self.supersede_fd(fd, false);
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
                target,
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
        target: Target,
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
                target,
                timer_id,
                deadline: Instant::now() + Duration::from_millis(ms),
                referenced,
            },
        );
        self.timers.insert(timer_id, id);
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

    /// Enforce one live registration per descriptor and direction. Pointer
    /// records move to `doomed` until Cherenkov confirms cancellation, keeping
    /// their backing stores valid for the kernel.
    fn supersede_fd(&mut self, fd: i32, read: bool) {
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
            return Dispatch::External;
        };
        match record {
            Record::Read {
                owner,
                target,
                buffer,
                fd,
                ptr,
                len,
                referenced: _,
            } => {
                if res == -libc::EAGAIN
                    && let Some(buffer) = buffer
                {
                    self.submit_read(owner, target, buffer, fd, ptr, len as usize);
                    return Dispatch::Handled;
                }
                self.unindex(fd, id, true);
                Dispatch::Resolved(Resolved {
                    target,
                    result: res as f64,
                })
            }
            Record::Write {
                owner,
                target,
                buffer,
                fd,
                base,
                len,
                done,
            } => {
                if res == -libc::EAGAIN {
                    self.resubmit_write(owner, target, buffer, fd, base, len, done);
                    return Dispatch::Handled;
                }
                if res < 0 {
                    self.unindex(fd, id, false);
                    return Dispatch::Resolved(Resolved {
                        target,
                        result: res as f64,
                    });
                }
                let done = done + res as u32;
                if done >= len {
                    self.unindex(fd, id, false);
                    Dispatch::Resolved(Resolved {
                        target,
                        result: done as f64,
                    })
                } else {
                    self.resubmit_write(owner, target, buffer, fd, base, len, done);
                    Dispatch::Handled
                }
            }
            Record::Timer {
                target, timer_id, ..
            } => {
                self.timers.remove(&timer_id);
                Dispatch::Resolved(Resolved {
                    target,
                    result: 0.0,
                })
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn resubmit_write(
        &mut self,
        owner: Owner,
        target: Target,
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
                target,
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
            }
        }
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
                    target: Target { resolver_id, .. },
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
                    target: Target { resolver_id, .. },
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
                } => self.submit_readiness(
                    owner,
                    Target {
                        id: owner,
                        resolver_id,
                    },
                    fd,
                    read,
                    referenced,
                ),
                Transfer::Timer {
                    resolver_id,
                    timer_id,
                    deadline,
                    referenced,
                } => self.submit_timer(
                    owner,
                    Target {
                        id: owner,
                        resolver_id,
                    },
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
