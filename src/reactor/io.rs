//! Shared Fino ownership layer over `cherenkov::Reactor`.
//!
//! Cherenkov owns submission, backend polling, cancellation, timers, and the
//! exactly-one-completion contract. This adapter owns only the state Cherenkov
//! deliberately leaves to its consumer: JS buffer retention, promise routing,
//! stable timer handles, and per-realm liveness accounting.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use cherenkov::{CURRENT_POS, Completion, Op, Reactor, Source};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum Owner {
    Host(usize),
    Workload(u64),
}

pub(crate) enum Target {
    Host(v8::Global<v8::PromiseResolver>),
    Workload { id: u64, resolver_id: usize },
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

impl Counts {
    pub fn total(self) -> u32 {
        self.reads + self.writes + self.timers
    }
}

pub(crate) enum Transfer {
    Readiness {
        resolver_id: usize,
        fd: i32,
        read: bool,
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

    pub fn create() -> std::io::Result<Self> {
        Reactor::new().map(Self::new)
    }

    pub fn notifier(&self) -> cherenkov::Notifier {
        self.reactor.notifier()
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

    pub fn submit_readiness(&mut self, owner: Owner, target: Target, fd: i32, read: bool) {
        let index = if read {
            &mut self.reads
        } else {
            &mut self.writes
        };
        if let Some(old) = index.get(&fd).copied()
            && matches!(
                self.records.get(&old),
                Some(Record::Read { buffer: None, .. })
            )
        {
            self.reactor.cancel(old);
            self.records.remove(&old);
        }
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
        let id = self.next_id();
        let base = base as u64;
        let len = len as u32;
        let done = done as u32;
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

    pub fn submit_host_timer(&mut self, owner: Owner, target: Target, ms: u64) -> u64 {
        let timer_id = self.next_id;
        self.submit_timer(owner, target, timer_id, ms, true);
        timer_id
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
        let owner = Owner::Workload(owner);
        let ids: Vec<u64> = self
            .records
            .iter()
            .filter_map(|(id, record)| match record {
                Record::Read {
                    owner: record_owner,
                    target: Target::Workload { .. },
                    buffer: None,
                    ..
                }
                | Record::Timer {
                    owner: record_owner,
                    target: Target::Workload { .. },
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
                    target: Target::Workload { resolver_id, .. },
                    fd,
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
                    });
                }
                Record::Timer {
                    target: Target::Workload { resolver_id, .. },
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
                } => self.submit_readiness(
                    Owner::Workload(owner),
                    Target::Workload {
                        id: owner,
                        resolver_id,
                    },
                    fd,
                    read,
                ),
                Transfer::Timer {
                    resolver_id,
                    timer_id,
                    deadline,
                    referenced,
                } => self.submit_timer(
                    Owner::Workload(owner),
                    Target::Workload {
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
