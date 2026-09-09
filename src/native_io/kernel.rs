//! Platform readiness driver with opaque, generation-stable operation tokens.

use std::collections::{BTreeSet, HashMap};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

pub(crate) struct Event {
    pub token: u64,
    pub data: i64,
    pub flags: u32,
}

pub(crate) struct Kernel {
    fd: OwnedFd,
    watches: HashMap<u64, (RawFd, i32)>,
    groups: HashMap<(RawFd, i32), BTreeSet<u64>>,
    #[cfg(target_os = "linux")]
    signals: HashMap<RawFd, OwnedFd>,
}

impl Kernel {
    pub fn new() -> io::Result<Self> {
        #[cfg(target_os = "macos")]
        let fd = unsafe { libc::kqueue() };
        #[cfg(target_os = "linux")]
        let fd = unsafe { libc::epoll_create1(libc::EPOLL_CLOEXEC) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        unsafe {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
        Ok(Self {
            fd: unsafe { OwnedFd::from_raw_fd(fd) },
            watches: HashMap::new(),
            groups: HashMap::new(),
            #[cfg(target_os = "linux")]
            signals: HashMap::new(),
        })
    }

    pub fn arm(&mut self, token: u64, ident: RawFd, filter: i32, flags: u32) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        if !matches!(filter, -1 | -2 | -6) {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "unsupported Linux readiness filter",
            ));
        }
        if let Some(group) = self.groups.get_mut(&(ident, filter)) {
            group.insert(token);
            self.watches.insert(token, (ident, filter));
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        {
            let change = libc::kevent {
                ident: ident as usize,
                filter: filter as i16,
                flags: libc::EV_ADD | libc::EV_CLEAR | libc::EV_RECEIPT,
                fflags: if filter == -5 { libc::NOTE_EXIT } else { flags },
                data: 0,
                udata: token as usize as *mut _,
            };
            let mut receipt: libc::kevent = unsafe { std::mem::zeroed() };
            let zero = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            let count =
                unsafe { libc::kevent(self.fd.as_raw_fd(), &change, 1, &mut receipt, 1, &zero) };
            if count < 0 {
                return Err(io::Error::last_os_error());
            }
            if receipt.data != 0 {
                return Err(io::Error::from_raw_os_error(receipt.data as i32));
            }
            self.watches.insert(token, (ident, filter));
        }
        #[cfg(target_os = "linux")]
        {
            let _ = flags;
            let fd = if filter == -6 {
                let mut mask = unsafe { std::mem::zeroed() };
                unsafe {
                    libc::sigemptyset(&mut mask);
                    libc::sigaddset(&mut mask, ident);
                }
                let fd =
                    unsafe { libc::signalfd(-1, &mask, libc::SFD_NONBLOCK | libc::SFD_CLOEXEC) };
                if fd < 0 {
                    return Err(io::Error::last_os_error());
                }
                self.signals
                    .insert(ident, unsafe { OwnedFd::from_raw_fd(fd) });
                fd
            } else {
                ident
            };
            let mut event = libc::epoll_event {
                events: (if filter == -2 {
                    libc::EPOLLOUT
                } else {
                    libc::EPOLLIN
                }) as u32
                    | libc::EPOLLET as u32,
                u64: token,
            };
            if unsafe { libc::epoll_ctl(self.fd.as_raw_fd(), libc::EPOLL_CTL_ADD, fd, &mut event) }
                < 0
            {
                self.signals.remove(&ident);
                return Err(io::Error::last_os_error());
            }
            self.watches.insert(token, (ident, filter));
        }
        self.groups.insert((ident, filter), BTreeSet::from([token]));
        Ok(())
    }

    pub fn remove(&mut self, token: u64) {
        if let Some((fd, filter)) = self.watches.remove(&token) {
            let group = self.groups.get_mut(&(fd, filter)).unwrap();
            group.remove(&token);
            if !group.is_empty() {
                #[cfg(target_os = "linux")]
                {
                    let native_fd = self
                        .signals
                        .get(&fd)
                        .filter(|_| filter == -6)
                        .map_or(fd, AsRawFd::as_raw_fd);
                    let mut event = libc::epoll_event {
                        events: (if filter == -2 {
                            libc::EPOLLOUT
                        } else {
                            libc::EPOLLIN
                        }) as u32
                            | libc::EPOLLET as u32,
                        u64: *group.iter().next().unwrap(),
                    };
                    unsafe {
                        libc::epoll_ctl(
                            self.fd.as_raw_fd(),
                            libc::EPOLL_CTL_MOD,
                            native_fd,
                            &mut event,
                        );
                    }
                }
                return;
            }
            self.groups.remove(&(fd, filter));
            #[cfg(target_os = "macos")]
            {
                let change = libc::kevent {
                    ident: fd as usize,
                    filter: filter as i16,
                    flags: libc::EV_DELETE,
                    fflags: 0,
                    data: 0,
                    udata: std::ptr::null_mut(),
                };
                unsafe {
                    libc::kevent(
                        self.fd.as_raw_fd(),
                        &change,
                        1,
                        std::ptr::null_mut(),
                        0,
                        std::ptr::null(),
                    );
                }
            }
            #[cfg(target_os = "linux")]
            {
                let native_fd = self
                    .signals
                    .get(&fd)
                    .filter(|_| filter == -6)
                    .map_or(fd, AsRawFd::as_raw_fd);
                unsafe {
                    libc::epoll_ctl(
                        self.fd.as_raw_fd(),
                        libc::EPOLL_CTL_DEL,
                        native_fd,
                        std::ptr::null_mut(),
                    );
                }
                if filter == -6 {
                    self.signals.remove(&fd);
                }
            }
        }
    }

    pub fn wait(&mut self, timeout_ms: i32) -> io::Result<Vec<Event>> {
        #[cfg(target_os = "macos")]
        {
            let mut events: [libc::kevent; 256] = unsafe { std::mem::zeroed() };
            let timeout = libc::timespec {
                tv_sec: (timeout_ms.max(0) / 1000) as _,
                tv_nsec: ((timeout_ms.max(0) % 1000) * 1_000_000) as _,
            };
            let count = unsafe {
                libc::kevent(
                    self.fd.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    events.as_mut_ptr(),
                    events.len() as i32,
                    if timeout_ms < 0 {
                        std::ptr::null()
                    } else {
                        &timeout
                    },
                )
            };
            if count < 0 {
                return interrupted();
            }
            Ok(events[..count as usize]
                .iter()
                .flat_map(|event| {
                    self.groups
                        .get(&(event.ident as RawFd, event.filter as i32))
                        .into_iter()
                        .flatten()
                        .map(move |token| Event {
                            token: *token,
                            data: event.data as i64,
                            flags: event.fflags,
                        })
                })
                .collect())
        }
        #[cfg(target_os = "linux")]
        {
            let mut events: [libc::epoll_event; 256] = unsafe { std::mem::zeroed() };
            let count = unsafe {
                libc::epoll_wait(
                    self.fd.as_raw_fd(),
                    events.as_mut_ptr(),
                    events.len() as i32,
                    timeout_ms,
                )
            };
            if count < 0 {
                return interrupted();
            }
            let mut result = Vec::new();
            for event in &events[..count as usize] {
                let token = event.u64;
                let Some(&(ident, filter)) = self.watches.get(&token) else {
                    continue;
                };
                if let Some(fd) = self.signals.get(&ident).filter(|_| filter == -6) {
                    let mut info: libc::signalfd_siginfo = unsafe { std::mem::zeroed() };
                    while unsafe {
                        libc::read(
                            fd.as_raw_fd(),
                            (&mut info as *mut libc::signalfd_siginfo).cast(),
                            std::mem::size_of_val(&info),
                        )
                    } > 0
                    {}
                }
                for token in &self.groups[&(ident, filter)] {
                    result.push(Event {
                        token: *token,
                        data: 0,
                        flags: 0,
                    });
                }
            }
            Ok(result)
        }
    }
}

fn interrupted() -> io::Result<Vec<Event>> {
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::Interrupted {
        Ok(Vec::new())
    } else {
        Err(error)
    }
}
