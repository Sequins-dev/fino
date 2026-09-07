//! Shared non-blocking pipe and wake helpers.
//!
//! Every cross-thread hand-off in the runtime needs the same primitive: a
//! non-blocking self-pipe that marks a descriptor readable so a poll-based
//! loop notices, plus wake/drain operations on either end. This module is the
//! single owner of that plumbing; `scheduler_native`, the realm transports,
//! and the FFI completion path all consume it.

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

/// Create a non-blocking pipe, returning `(read, write)`.
///
/// Both ends are set `O_NONBLOCK` so wake writes never block when the pipe is
/// full and drains never block when it is empty.
pub fn create_pipe() -> Result<(RawFd, RawFd), String> {
    let mut fds = [-1; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(format!(
            "pipe() failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    for fd in fds {
        unsafe {
            libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK);
        }
    }
    Ok((fds[0], fds[1]))
}

/// Mark a raw write descriptor readable by writing one wake byte.
///
/// The payload carries no information — the queue behind the pipe does — so a
/// failed write is deliberately ignored: it means either the reader is gone,
/// or the pipe is already full of undrained bytes. In both cases the
/// descriptor is already readable and the reader will wake, so there is
/// nothing to recover.
pub fn wake(write: RawFd) {
    let byte = [1u8];
    unsafe {
        libc::write(write, byte.as_ptr().cast(), byte.len());
    }
}

/// Drain all pending wake bytes from a raw read descriptor a caller owns.
///
/// Non-blocking; `EAGAIN` means no more bytes and is ignored.
pub fn drain(read: RawFd) {
    let mut bytes = [0u8; 64];
    while unsafe { libc::read(read, bytes.as_mut_ptr().cast(), bytes.len()) } > 0 {}
}

/// A non-blocking self-pipe used to make a descriptor readable on demand.
///
/// Owns both ends and closes them on drop. Use the free functions [`wake`]
/// and [`drain`] when a caller owns only one end of a pipe (e.g. the write
/// end handed to a partner realm).
pub struct WakePipe {
    read: OwnedFd,
    write: OwnedFd,
}

impl WakePipe {
    pub fn new() -> Result<Self, String> {
        let (read, write) = create_pipe()?;
        // SAFETY: create_pipe returned two fresh descriptors owned here.
        Ok(Self::from_owned_fds(
            unsafe { OwnedFd::from_raw_fd(read) },
            unsafe { OwnedFd::from_raw_fd(write) },
        ))
    }

    /// Adopt both ends of an existing non-blocking wake pipe.
    pub fn from_owned_fds(read: OwnedFd, write: OwnedFd) -> Self {
        Self { read, write }
    }

    pub fn read_fd(&self) -> RawFd {
        self.read.as_raw_fd()
    }

    pub fn notify(&self) {
        wake(self.write.as_raw_fd());
    }

    pub fn drain(&self) {
        drain(self.read.as_raw_fd());
    }
}
