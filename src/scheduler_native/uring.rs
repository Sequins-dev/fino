//! Single-owner readiness ring. Cancellation never releases an
//! operation's resources before its original terminal completion arrives.
use io_uring::{IoUring, opcode, squeue, types};
use std::collections::{HashMap, VecDeque};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

struct Poll {
    fd: OwnedFd,
    mask: u32,
}
struct Request {
    token: u64,
    poll: Poll,
    cancelled: bool,
}
pub(super) struct Ring {
    ring: IoUring,
    queued: VecDeque<squeue::Entry>,
    requests: HashMap<u64, Request>,
    tokens: HashMap<u64, u64>,
    next: u64,
}
impl Ring {
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            ring: IoUring::new(1024)?,
            queued: VecDeque::new(),
            requests: HashMap::new(),
            tokens: HashMap::new(),
            next: 1,
        })
    }
    fn insert(&mut self, token: u64, entry: squeue::Entry, poll: Poll) {
        let id = self.next;
        self.next += 1;
        self.tokens.insert(token, id);
        self.requests.insert(
            id,
            Request {
                token,
                poll,
                cancelled: false,
            },
        );
        self.queued.push_back(entry.user_data(id));
    }
    pub fn poll(&mut self, token: u64, fd: RawFd, mask: u32) -> io::Result<()> {
        let copied = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        if copied < 0 {
            return Err(io::Error::last_os_error());
        }
        let fd = unsafe { OwnedFd::from_raw_fd(copied) };
        let entry = opcode::PollAdd::new(types::Fd(copied), mask).build();
        self.insert(token, entry, Poll { fd, mask });
        Ok(())
    }
    pub fn cancel(&mut self, token: u64) {
        let Some(id) = self.tokens.remove(&token) else {
            return;
        };
        if let Some(request) = self.requests.get_mut(&id) {
            request.cancelled = true;
            self.queued
                .push_back(opcode::AsyncCancel::new(id).build().user_data(0));
        }
    }
    fn flush(&mut self) {
        let mut sq = self.ring.submission();
        while let Some(entry) = self.queued.front() {
            // Bound each submission batch and drain CQEs between batches.
            // All referenced descriptors live in the driver until CQE.
            if unsafe { sq.push(entry) }.is_err() {
                break;
            }
            self.queued.pop_front();
        }
    }
    pub fn wait(&mut self, timeout_ms: i32) -> io::Result<Vec<(u64, i32)>> {
        self.flush();
        let timeout_ms = if self.queued.is_empty() {
            timeout_ms
        } else {
            0
        };
        let result = if timeout_ms < 0 {
            self.ring.submit_and_wait(1)
        } else if timeout_ms == 0 {
            self.ring.submit()
        } else if self.ring.params().is_feature_ext_arg() {
            let ts = types::Timespec::new()
                .sec((timeout_ms / 1000) as u64)
                .nsec(((timeout_ms % 1000) * 1_000_000) as u32);
            self.ring
                .submitter()
                .submit_with_args(1, &types::SubmitArgs::new().timespec(&ts))
        } else {
            // EXT_ARG arrived in Linux 5.11. Older io_uring kernels can still
            // bound the host wait by polling the ring's completion descriptor.
            self.ring.submit()?;
            let mut fd = libc::pollfd {
                fd: self.ring.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let result = unsafe { libc::poll(&mut fd, 1, timeout_ms) };
            if result < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(result as usize)
            }
        };
        if let Err(error) = result {
            if !matches!(error.raw_os_error(), Some(libc::ETIME | libc::EINTR)) {
                return Err(error);
            }
        }
        let cqes: Vec<_> = self
            .ring
            .completion()
            .map(|c| (c.user_data(), c.result()))
            .collect();
        let mut events = Vec::new();
        for (id, result) in cqes {
            let Some(request) = self.requests.remove(&id) else {
                continue;
            };
            if self.tokens.get(&request.token) == Some(&id) {
                self.tokens.remove(&request.token);
            }
            let poll = request.poll;
            if !request.cancelled && result >= 0 {
                events.push((request.token, result));
                let entry = opcode::PollAdd::new(types::Fd(poll.fd.as_raw_fd()), poll.mask).build();
                self.insert(request.token, entry, poll);
            } else if !request.cancelled && result != -libc::ECANCELED {
                return Err(io::Error::from_raw_os_error(-result));
            }
        }
        Ok(events)
    }
}
impl Drop for Ring {
    fn drop(&mut self) {
        let tokens: Vec<_> = self.tokens.keys().copied().collect();
        for token in tokens {
            self.cancel(token);
        }
        while !self.requests.is_empty() {
            if self.wait(-1).is_err() {
                // A failed drain cannot justify freeing kernel-visible memory.
                std::process::abort();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::time::{Duration, Instant};

    #[test]
    fn queues_past_ring_capacity_and_drains_cancelled_watches() {
        let mut ring = Ring::new().unwrap();
        let (reader, mut writer) = UnixStream::pair().unwrap();
        let count = 1100;
        for token in 1..=count {
            ring.poll(token, reader.as_raw_fd(), libc::POLLIN as u32)
                .unwrap();
        }
        writer.write_all(&[1]).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen = HashSet::new();
        while seen.len() < count as usize {
            for (token, _) in ring.wait(10).unwrap() {
                seen.insert(token);
            }
            assert!(Instant::now() < deadline, "queued readiness was lost");
        }
        for token in 1..=count {
            ring.cancel(token);
        }
        while !ring.requests.is_empty() {
            assert!(
                ring.wait(10).unwrap().is_empty(),
                "cancelled watch was delivered"
            );
            assert!(Instant::now() < deadline, "cancelled watches did not drain");
        }
        assert!(ring.tokens.is_empty());
    }
}
