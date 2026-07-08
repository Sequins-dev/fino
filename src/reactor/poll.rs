//! The reactor's completion-based poller.
//!
//! The reactor's I/O model is **completion-centric** — the io_uring shape, since
//! Linux is the primary deployment target. A caller *submits an operation*
//! (read, write, poll-readiness, timeout) tagged with an opaque `user_data`, and
//! later gets a `Completion { user_data, res }` where `res` is the operation's
//! result (byte count, poll mask, or `-errno`). There is no public "readiness
//! then do-the-syscall-yourself" step.
//!
//! - On **Linux** (`IoUringPoller`), a submission maps directly to an io_uring
//!   SQE; the kernel performs the work and the CQE `res` *is* the result.
//! - On **macOS** (`KqueuePoller`), kqueue only reports readiness, so the backend
//!   *emulates* completions: it registers the matching `EVFILT_READ`/`WRITE`,
//!   and on the readiness event performs the `read`/`write(2)` itself and
//!   synthesizes the same `Completion`. The readiness dance is a private detail
//!   of the macOS adapter, never part of the model the reactor codes against.
//!
//! `Poller` is a zero-cost cfg alias for whichever backend the target uses; both
//! expose the same inherent API (`new`/`submit`/`cancel`/`wait`).

use std::os::fd::RawFd;

/// An operation submitted to the poller. `buf_ptr` is a raw pointer whose
/// backing storage the *caller* keeps alive until the completion arrives;
/// `off == u64::MAX` means "use the fd's current position" (no seek).
pub enum Op {
    Read {
        fd: RawFd,
        buf_ptr: u64,
        len: u32,
        off: u64,
    },
    Write {
        fd: RawFd,
        buf_ptr: u64,
        len: u32,
        off: u64,
    },
    /// Bare read-readiness (for ops that can't be fused — accept, connect
    /// completion, TLS handshakes). Completes with the bytes-available hint.
    PollIn {
        fd: RawFd,
    },
    /// Bare write-readiness. Completes with 0.
    PollOut {
        fd: RawFd,
    },
    /// One-shot timer; completes after `ms` milliseconds.
    Timeout {
        ms: i64,
    },
}

/// One finished operation: the `user_data` from the submission and its result
/// (`res >= 0` is a byte count / poll mask; `res < 0` is `-errno`).
pub struct Completion {
    pub user_data: u64,
    pub res: i32,
}

#[cfg(target_os = "linux")]
pub use uring::IoUringPoller as Poller;
#[cfg(target_os = "macos")]
pub use kqueue::KqueuePoller as Poller;

// ===========================================================================
// Linux — io_uring: submissions map straight to SQEs, CQEs are the completions.
// ===========================================================================
#[cfg(target_os = "linux")]
mod uring {
    use super::{Completion, Op};
    use crate::reactor::io_uring::{
        IORING_OP_POLL_ADD, IORING_OP_READ, IORING_OP_TIMEOUT, IORING_OP_WRITE, KernelTimespec,
        POLLIN, POLLOUT, Ring,
    };
    use std::collections::HashMap;

    pub struct IoUringPoller {
        ring: Ring,
        /// Timespecs for outstanding `OP_TIMEOUT`s — the SQE points at them, so
        /// they must outlive submission-until-completion. Keyed by `user_data`.
        timers: HashMap<u64, Box<KernelTimespec>>,
    }

    impl IoUringPoller {
        pub fn new() -> std::io::Result<Self> {
            Ok(Self {
                ring: Ring::new(256)?,
                timers: HashMap::new(),
            })
        }

        pub fn submit(&mut self, user_data: u64, op: Op) {
            let _ = match op {
                Op::Read {
                    fd,
                    buf_ptr,
                    len,
                    off,
                } => self.ring.push(IORING_OP_READ, fd, buf_ptr, len, off, user_data, 0),
                Op::Write {
                    fd,
                    buf_ptr,
                    len,
                    off,
                } => self
                    .ring
                    .push(IORING_OP_WRITE, fd, buf_ptr, len, off, user_data, 0),
                Op::PollIn { fd } => {
                    self.ring
                        .push(IORING_OP_POLL_ADD, fd, 0, 0, 0, user_data, POLLIN)
                }
                Op::PollOut { fd } => {
                    self.ring
                        .push(IORING_OP_POLL_ADD, fd, 0, 0, 0, user_data, POLLOUT)
                }
                Op::Timeout { ms } => {
                    let ts = Box::new(KernelTimespec {
                        tv_sec: ms / 1000,
                        tv_nsec: (ms % 1000) * 1_000_000,
                    });
                    let addr = ts.as_ref() as *const KernelTimespec as u64;
                    self.timers.insert(user_data, ts);
                    self.ring
                        .push(IORING_OP_TIMEOUT, -1, addr, 1, 0, user_data, 0)
                }
            };
        }

        pub fn cancel(&mut self, _user_data: u64) {
            // io_uring cancellation (OP_ASYNC_CANCEL / TIMEOUT_REMOVE) lands with
            // the reactor's owner-revocation path; the outstanding op still
            // completes and the reactor drops it. No-op here for now.
        }

        pub fn wait(&mut self, block: bool) -> Vec<Completion> {
            if block {
                let _ = self.ring.submit_and_wait();
            } else {
                let _ = self.ring.submit();
            }
            let comps: Vec<Completion> = self
                .ring
                .reap()
                .into_iter()
                .map(|c| Completion {
                    user_data: c.user_data,
                    res: c.res,
                })
                .collect();
            for c in &comps {
                self.timers.remove(&c.user_data);
            }
            comps
        }
    }
}

// ===========================================================================
// macOS — kqueue adapter: registers readiness, performs the syscall on the
// event, and synthesizes the same completions the io_uring backend produces.
// ===========================================================================
#[cfg(target_os = "macos")]
mod kqueue {
    use super::{Completion, Op};
    use std::collections::HashMap;
    use std::os::fd::RawFd;

    const MAX_EVENTS: usize = 256;

    fn errno() -> i32 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
    }

    pub struct KqueuePoller {
        kq: RawFd,
        /// Outstanding ops keyed by their kqueue `(ident, filter)`, so a readiness
        /// event can be mapped back to its `user_data` and performed.
        pending: HashMap<(usize, i16), (u64, Op)>,
        changes: Vec<libc::kevent>,
    }

    impl KqueuePoller {
        pub fn new() -> std::io::Result<Self> {
            let kq = unsafe { libc::kqueue() };
            if kq < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(Self {
                kq,
                pending: HashMap::new(),
                changes: Vec::new(),
            })
        }

        fn key(user_data: u64, op: &Op) -> (usize, i16) {
            match op {
                Op::Read { fd, .. } | Op::PollIn { fd } => (*fd as usize, libc::EVFILT_READ),
                Op::Write { fd, .. } | Op::PollOut { fd } => (*fd as usize, libc::EVFILT_WRITE),
                Op::Timeout { .. } => (user_data as usize, libc::EVFILT_TIMER),
            }
        }

        pub fn submit(&mut self, user_data: u64, op: Op) {
            let (ident, filter) = Self::key(user_data, &op);
            let data = match &op {
                Op::Timeout { ms } => *ms as isize,
                _ => 0,
            };
            self.changes.push(libc::kevent {
                ident,
                filter,
                flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
                fflags: 0,
                data,
                udata: std::ptr::null_mut(),
            });
            self.pending.insert((ident, filter), (user_data, op));
        }

        pub fn cancel(&mut self, user_data: u64) {
            let key = self
                .pending
                .iter()
                .find(|(_, (ud, _))| *ud == user_data)
                .map(|(k, _)| *k);
            if let Some((ident, filter)) = key {
                self.pending.remove(&(ident, filter));
                self.changes.push(libc::kevent {
                    ident,
                    filter,
                    flags: libc::EV_DELETE,
                    fflags: 0,
                    data: 0,
                    udata: std::ptr::null_mut(),
                });
            }
        }

        pub fn wait(&mut self, block: bool) -> Vec<Completion> {
            let changes = std::mem::take(&mut self.changes);
            let mut evbuf =
                [const { std::mem::MaybeUninit::<libc::kevent>::uninit() }; MAX_EVENTS];
            let zero = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            let timeout = if block {
                std::ptr::null()
            } else {
                &zero as *const _
            };
            let n = loop {
                let n = unsafe {
                    libc::kevent(
                        self.kq,
                        changes.as_ptr(),
                        changes.len() as i32,
                        evbuf.as_mut_ptr().cast::<libc::kevent>(),
                        MAX_EVENTS as i32,
                        timeout,
                    )
                };
                if n < 0 && errno() == libc::EINTR {
                    continue;
                }
                break n;
            };
            if n <= 0 {
                return Vec::new();
            }
            let mut out = Vec::new();
            for slot in evbuf.iter().take(n as usize) {
                let ev = unsafe { slot.assume_init_ref() };
                if ev.flags & libc::EV_ERROR != 0 {
                    continue;
                }
                let key = (ev.ident, ev.filter);
                if let Some((user_data, op)) = self.pending.remove(&key) {
                    let res = perform(&op, ev.data);
                    out.push(Completion { user_data, res });
                }
            }
            out
        }
    }

    /// Do the actual syscall a readiness event unblocked, producing the byte
    /// count / mask the io_uring backend would have returned in the CQE.
    fn perform(op: &Op, avail: isize) -> i32 {
        unsafe {
            match op {
                Op::Read {
                    fd,
                    buf_ptr,
                    len,
                    off,
                } => {
                    let p = *buf_ptr as *mut libc::c_void;
                    let n = if *off == u64::MAX {
                        libc::read(*fd, p, *len as usize)
                    } else {
                        libc::pread(*fd, p, *len as usize, *off as libc::off_t)
                    };
                    if n >= 0 { n as i32 } else { -errno() }
                }
                Op::Write {
                    fd,
                    buf_ptr,
                    len,
                    off,
                } => {
                    let p = *buf_ptr as *const libc::c_void;
                    let n = if *off == u64::MAX {
                        libc::write(*fd, p, *len as usize)
                    } else {
                        libc::pwrite(*fd, p, *len as usize, *off as libc::off_t)
                    };
                    if n >= 0 { n as i32 } else { -errno() }
                }
                Op::PollIn { .. } => avail.max(0) as i32,
                Op::PollOut { .. } => 0,
                Op::Timeout { .. } => 0,
            }
        }
    }

    impl Drop for KqueuePoller {
        fn drop(&mut self) {
            unsafe { libc::close(self.kq) };
        }
    }
}

// ===========================================================================
// Cross-platform behavioural tests — the same completion contract on both
// backends (io_uring on Linux, the kqueue adapter on macOS).
// ===========================================================================
#[cfg(test)]
mod tests {
    use super::*;

    /// Block on `wait` until a completion for `user_data` arrives, returning it.
    fn wait_for(p: &mut Poller, user_data: u64) -> Completion {
        loop {
            for c in p.wait(true) {
                if c.user_data == user_data {
                    return c;
                }
            }
        }
    }

    #[test]
    fn submit_write_read_timer() {
        let mut fds = [0i32; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let (r, w) = (fds[0], fds[1]);
        let mut p = Poller::new().expect("poller");

        let msg = b"completion model";
        p.submit(
            1,
            Op::Write {
                fd: w,
                buf_ptr: msg.as_ptr() as u64,
                len: msg.len() as u32,
                off: u64::MAX,
            },
        );
        let c = wait_for(&mut p, 1);
        assert_eq!(c.res, msg.len() as i32, "write completed with byte count");

        let mut buf = [0u8; 64];
        p.submit(
            2,
            Op::Read {
                fd: r,
                buf_ptr: buf.as_mut_ptr() as u64,
                len: buf.len() as u32,
                off: u64::MAX,
            },
        );
        let c = wait_for(&mut p, 2);
        assert_eq!(c.res, msg.len() as i32, "read completed with byte count");
        assert_eq!(&buf[..msg.len()], msg, "content round-tripped");

        p.submit(3, Op::Timeout { ms: 20 });
        let c = wait_for(&mut p, 3);
        assert_eq!(c.user_data, 3, "timer completed");

        unsafe {
            libc::close(r);
            libc::close(w);
        }
    }
}
