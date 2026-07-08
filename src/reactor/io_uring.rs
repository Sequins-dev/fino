//! Raw io_uring ring (Linux) for the native reactor.
//!
//! A direct port of `js/internal/runtime/io_uring.ts`'s wire handling into Rust:
//! `io_uring_setup(2)` + three `mmap(2)`'d shared regions (SQ ring, CQ ring, SQE
//! array) + `io_uring_enter(2)`. No liburing, no external crate — the same "thin,
//! no C helper lib" approach the JS loop used, but owned entirely by the reactor
//! thread so tenants never touch it (they only call the `internal:io` synthetic
//! module, which dispatches here).
//!
//! Only the reactor thread ever touches a `Ring`, and `io_uring_enter` is the
//! sync point with the kernel, so plain volatile loads/stores on the shared
//! head/tail counters are sufficient (matching `io_uring.ts`); no cross-thread
//! atomics are needed.
#![cfg(target_os = "linux")]

use std::io;
use std::os::fd::RawFd;
use std::ptr;

const SYS_IO_URING_SETUP: libc::c_long = 425;
const SYS_IO_URING_ENTER: libc::c_long = 426;

const IORING_OFF_SQ_RING: libc::off_t = 0;
const IORING_OFF_CQ_RING: libc::off_t = 0x0800_0000;
const IORING_OFF_SQES: libc::off_t = 0x1000_0000;

/// `io_uring_enter` flag: wait for at least `min_complete` completions.
const IORING_ENTER_GETEVENTS: libc::c_ulong = 1;

// SQE opcodes (stable on all archs).
pub const IORING_OP_POLL_ADD: u8 = 6;
pub const IORING_OP_TIMEOUT: u8 = 11;
pub const IORING_OP_TIMEOUT_REMOVE: u8 = 12;
pub const IORING_OP_READ: u8 = 22;
pub const IORING_OP_WRITE: u8 = 23;

// poll(2) masks used with IORING_OP_POLL_ADD.
pub const POLLIN: u32 = 0x0001;
pub const POLLOUT: u32 = 0x0004;

/// `__kernel_timespec` — what `IORING_OP_TIMEOUT` points at (`addr`).
#[repr(C)]
pub struct KernelTimespec {
    pub tv_sec: i64,
    pub tv_nsec: i64,
}

/// One completion drained from the CQ: the `user_data` echoed from the SQE and
/// the op's `res` (byte count, poll mask, or `-errno`).
pub struct Completion {
    pub user_data: u64,
    pub res: i32,
}

/// An owned io_uring instance: the ring fd plus its three mmap'd regions and the
/// byte offsets of the head/tail/mask/array/cqes counters within them.
pub struct Ring {
    fd: RawFd,
    sq_ring: *mut u8,
    sq_ring_size: usize,
    cq_ring: *mut u8,
    cq_ring_size: usize,
    sqes: *mut u8,
    sqes_size: usize,
    // SQ counter offsets (within sq_ring) and the SQE-index array offset.
    sq_tail_off: usize,
    sq_mask_off: usize,
    sq_array_off: usize,
    // CQ counter offsets (within cq_ring) and the CQE array offset.
    cq_head_off: usize,
    cq_tail_off: usize,
    cq_mask_off: usize,
    cq_cqes_off: usize,
    sq_entries: u32,
    /// Shadow of the SQ tail; SQEs are staged locally and published on submit.
    sq_tail_local: u32,
    /// SQEs already handed to the kernel by `io_uring_enter`.
    sq_submitted_local: u32,
}

#[inline]
unsafe fn read_u32(base: *mut u8, off: usize) -> u32 {
    unsafe { ptr::read_volatile(base.add(off) as *const u32) }
}
#[inline]
unsafe fn write_u32(base: *mut u8, off: usize, val: u32) {
    unsafe { ptr::write_volatile(base.add(off) as *mut u32, val) }
}
#[inline]
unsafe fn read_u64(base: *mut u8, off: usize) -> u64 {
    unsafe { ptr::read_volatile(base.add(off) as *const u64) }
}

impl Ring {
    /// Set up a ring sized for at least `entries` submission slots and map its
    /// three shared regions.
    pub fn new(entries: u32) -> io::Result<Ring> {
        // io_uring_params is 120 bytes; the kernel fills in sizes + offsets.
        let mut params = [0u8; 120];
        let fd = unsafe {
            libc::syscall(
                SYS_IO_URING_SETUP,
                entries as libc::c_long,
                params.as_mut_ptr() as libc::c_long,
            )
        } as RawFd;
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let rd = |off: usize| u32::from_ne_bytes(params[off..off + 4].try_into().unwrap());
        let sq_entries = rd(0);
        let cq_entries = rd(4);
        // io_sqring_offsets at params+40: head=0 tail=4 ring_mask=8 ring_entries=12
        //   flags=16 dropped=20 array=24
        let sq_tail_off = rd(40 + 4) as usize;
        let sq_mask_off = rd(40 + 8) as usize;
        let sq_array_off = rd(40 + 24) as usize;
        // io_cqring_offsets at params+80: head=0 tail=4 ring_mask=8 ring_entries=12
        //   overflow=16 cqes=20
        let cq_head_off = rd(80) as usize;
        let cq_tail_off = rd(80 + 4) as usize;
        let cq_mask_off = rd(80 + 8) as usize;
        let cq_cqes_off = rd(80 + 20) as usize;

        let sq_ring_size = sq_array_off + sq_entries as usize * 4;
        let cq_ring_size = cq_cqes_off + cq_entries as usize * 16;
        let sqes_size = sq_entries as usize * 64;

        let map = |size: usize, off: libc::off_t| -> *mut u8 {
            unsafe {
                libc::mmap(
                    ptr::null_mut(),
                    size,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_SHARED | libc::MAP_POPULATE,
                    fd,
                    off,
                ) as *mut u8
            }
        };
        let sq_ring = map(sq_ring_size, IORING_OFF_SQ_RING);
        let cq_ring = map(cq_ring_size, IORING_OFF_CQ_RING);
        let sqes = map(sqes_size, IORING_OFF_SQES);
        let failed = libc::MAP_FAILED as *mut u8;
        if sq_ring == failed || cq_ring == failed || sqes == failed {
            let e = io::Error::last_os_error();
            unsafe { libc::close(fd) };
            return Err(e);
        }

        let ring = Ring {
            fd,
            sq_ring,
            sq_ring_size,
            cq_ring,
            cq_ring_size,
            sqes,
            sqes_size,
            sq_tail_off,
            sq_mask_off,
            sq_array_off,
            cq_head_off,
            cq_tail_off,
            cq_mask_off,
            cq_cqes_off,
            sq_entries,
            sq_tail_local: unsafe { read_u32(sq_ring, sq_tail_off) },
            sq_submitted_local: 0,
        };
        Ok(ring)
    }

    /// Stage a submission-queue entry (write the 64-byte SQE and publish the
    /// tail). Flushes to the kernel first if the SQ has no free slot.
    ///
    /// `addr`/`len`/`off` are opcode-specific: for READ/WRITE, `addr` is the
    /// buffer pointer, `len` the byte count, `off` the file offset (`!0` = use
    /// the fd's current position); for POLL_ADD, `poll_events` is the mask; for
    /// TIMEOUT, `addr` is a `*KernelTimespec` and `len` is 1.
    #[allow(clippy::too_many_arguments)]
    pub fn push(
        &mut self,
        opcode: u8,
        fd: i32,
        addr: u64,
        len: u32,
        off: u64,
        user_data: u64,
        poll_events: u32,
    ) -> io::Result<()> {
        if self.sq_tail_local.wrapping_sub(self.sq_submitted_local) >= self.sq_entries {
            self.submit()?;
        }
        let mask = unsafe { read_u32(self.sq_ring, self.sq_mask_off) };
        let tail = self.sq_tail_local;
        let index = tail & mask;
        let sqe = index as usize * 64;
        unsafe {
            // Zero the SQE slot, then write the fields at their fixed offsets.
            ptr::write_bytes(self.sqes.add(sqe), 0, 64);
            ptr::write_volatile(self.sqes.add(sqe), opcode);
            ptr::write_volatile(self.sqes.add(sqe + 4) as *mut i32, fd);
            ptr::write_volatile(self.sqes.add(sqe + 8) as *mut u64, off);
            ptr::write_volatile(self.sqes.add(sqe + 16) as *mut u64, addr);
            ptr::write_volatile(self.sqes.add(sqe + 24) as *mut u32, len);
            ptr::write_volatile(self.sqes.add(sqe + 28) as *mut u32, poll_events);
            ptr::write_volatile(self.sqes.add(sqe + 32) as *mut u64, user_data);
            // Point the SQ array slot at this SQE and publish the new tail.
            write_u32(self.sq_ring, self.sq_array_off + index as usize * 4, index);
        }
        self.sq_tail_local = tail.wrapping_add(1);
        unsafe { write_u32(self.sq_ring, self.sq_tail_off, self.sq_tail_local) };
        Ok(())
    }

    /// Submit all staged SQEs to the kernel (no wait).
    pub fn submit(&mut self) -> io::Result<()> {
        self.enter(0)
    }

    /// Submit staged SQEs and block until at least one completion is available,
    /// or until the ring's registered timeout fires. Returns the number the
    /// kernel accepted/reaped.
    pub fn submit_and_wait(&mut self) -> io::Result<()> {
        self.enter(1)
    }

    fn enter(&mut self, min_complete: libc::c_ulong) -> io::Result<()> {
        let to_submit = self.sq_tail_local.wrapping_sub(self.sq_submitted_local);
        let flags = if min_complete > 0 {
            IORING_ENTER_GETEVENTS
        } else {
            0
        };
        if to_submit == 0 && min_complete == 0 {
            return Ok(());
        }
        loop {
            let ret = unsafe {
                libc::syscall(
                    SYS_IO_URING_ENTER,
                    self.fd as libc::c_long,
                    to_submit as libc::c_long,
                    min_complete as libc::c_long,
                    flags as libc::c_long,
                    0 as libc::c_long,
                    0 as libc::c_long,
                )
            };
            if ret < 0 {
                let e = io::Error::last_os_error();
                if e.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(e);
            }
            // `ret` is the number of SQEs consumed.
            self.sq_submitted_local = self.sq_submitted_local.wrapping_add(ret as u32);
            return Ok(());
        }
    }

    /// Drain all available completions from the CQ.
    pub fn reap(&mut self) -> Vec<Completion> {
        let mut out = Vec::new();
        let mask = unsafe { read_u32(self.cq_ring, self.cq_mask_off) };
        let tail = unsafe { read_u32(self.cq_ring, self.cq_tail_off) };
        let mut head = unsafe { read_u32(self.cq_ring, self.cq_head_off) };
        while head != tail {
            let cqe = self.cq_cqes_off + (head & mask) as usize * 16;
            let user_data = unsafe { read_u64(self.cq_ring, cqe) };
            let res = unsafe { read_u32(self.cq_ring, cqe + 8) } as i32;
            out.push(Completion { user_data, res });
            head = head.wrapping_add(1);
        }
        // Publish the consumed head so the kernel can reuse the slots.
        unsafe { write_u32(self.cq_ring, self.cq_head_off, head) };
        out
    }

    pub fn ring_fd(&self) -> RawFd {
        self.fd
    }
}

impl Drop for Ring {
    fn drop(&mut self) {
        unsafe {
            libc::munmap(self.sqes as *mut libc::c_void, self.sqes_size);
            libc::munmap(self.cq_ring as *mut libc::c_void, self.cq_ring_size);
            libc::munmap(self.sq_ring as *mut libc::c_void, self.sq_ring_size);
            libc::close(self.fd);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_completes() {
        let mut ring = Ring::new(8).expect("io_uring_setup");
        let ts = KernelTimespec {
            tv_sec: 0,
            tv_nsec: 20_000_000,
        };
        ring.push(
            IORING_OP_TIMEOUT,
            -1,
            &ts as *const _ as u64,
            1,
            0,
            0xABCD,
            0,
        )
        .expect("push timeout");
        ring.submit_and_wait().expect("enter");
        let comps = ring.reap();
        assert_eq!(comps.len(), 1, "one completion");
        assert_eq!(comps[0].user_data, 0xABCD, "user_data echoed");
    }

    #[test]
    fn read_write_pipe() {
        // Fused OP_WRITE then OP_READ over a pipe — the completion `res` IS the
        // byte count, no separate readiness step (the io_uring-native path).
        let mut fds = [0i32; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let (r, w) = (fds[0], fds[1]);
        let mut ring = Ring::new(8).unwrap();
        let msg = b"hello uring";
        ring.push(IORING_OP_WRITE, w, msg.as_ptr() as u64, msg.len() as u32, u64::MAX, 1, 0)
            .unwrap();
        ring.submit_and_wait().unwrap();
        let c = ring.reap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].res, msg.len() as i32, "OP_WRITE wrote all bytes");
        let mut buf = [0u8; 32];
        ring.push(IORING_OP_READ, r, buf.as_mut_ptr() as u64, buf.len() as u32, u64::MAX, 2, 0)
            .unwrap();
        ring.submit_and_wait().unwrap();
        let c = ring.reap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].res, msg.len() as i32, "OP_READ read all bytes");
        assert_eq!(&buf[..msg.len()], msg, "content round-tripped");
        unsafe {
            libc::close(r);
            libc::close(w);
        }
    }

    #[test]
    fn poll_readable() {
        // OP_POLL_ADD readiness (the fallback for cases that can't be fused).
        let mut fds = [0i32; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let (r, w) = (fds[0], fds[1]);
        let mut ring = Ring::new(8).unwrap();
        ring.push(IORING_OP_POLL_ADD, r, 0, 0, 0, 7, POLLIN).unwrap();
        ring.submit().unwrap();
        unsafe { libc::write(w, b"x".as_ptr() as *const libc::c_void, 1) };
        ring.submit_and_wait().unwrap();
        let c = ring.reap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].user_data, 7, "poll user_data echoed");
        assert!(c[0].res & POLLIN as i32 != 0, "poll reported readable");
        unsafe {
            libc::close(r);
            libc::close(w);
        }
    }
}
