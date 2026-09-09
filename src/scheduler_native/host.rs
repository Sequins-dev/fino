//! Main-thread host. This module never creates a V8 scope or enters an isolate.

use super::*;
use crate::native_io::kernel::Kernel;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub(super) static IO_BACKEND: OnceLock<&'static str> = OnceLock::new();

#[derive(Default)]
struct Isolates {
    stopping: bool,
    handles: HashMap<u32, v8::IsolateHandle>,
}
fn isolates() -> &'static Mutex<Isolates> {
    static ISOLATES: OnceLock<Mutex<Isolates>> = OnceLock::new();
    ISOLATES.get_or_init(Default::default)
}
pub(super) fn register_isolate(owner: u32, handle: v8::IsolateHandle) {
    let mut isolates = isolates().lock().unwrap();
    if isolates.stopping {
        handle.terminate_execution();
    }
    isolates.handles.insert(owner, handle);
}
pub(super) fn unregister_isolate(owner: u32) {
    isolates().lock().unwrap().handles.remove(&owner);
}

struct Registration {
    change: ReadinessChange,
    deadline: Option<Instant>,
}

impl Registration {
    fn owner(&self) -> u32 {
        if self.change.scheduler_wake || self.change.scheduler_poll {
            self.change.udata as u32
        } else {
            (self.change.udata / 4294967296.0) as u32
        }
    }
    fn key(&self) -> (u32, i32, u64) {
        (
            self.owner(),
            if self.change.scheduler_wake {
                1
            } else if self.change.scheduler_poll {
                2
            } else {
                self.change.filter
            },
            self.change.ident as u64,
        )
    }
}

struct Driver {
    kernel: Kernel,
    io: crate::native_io::Engine,
    registrations: HashMap<u64, Registration>,
    keys: HashMap<(u32, i32, u64), u64>,
}

impl Drop for Driver {
    fn drop(&mut self) {
        let tokens: Vec<_> = self.registrations.keys().copied().collect();
        for token in tokens {
            self.remove(token);
        }
        let mut mail = mailbox().inner.lock().unwrap();
        mail.changes.clear();
        mail.borrowed_fds.clear();
        mail.events.clear();
        CONTROLLER_REGISTRATIONS.store(0, Ordering::Relaxed);
    }
}

impl Driver {
    fn new(pool: &PoolShared) -> Result<Self, String> {
        let mut kernel = Kernel::new().map_err(|e| e.to_string())?;
        let _ = IO_BACKEND.set(kernel.name());
        kernel
            .arm(1, mailbox().wake.read_fd(), -1, 0)
            .map_err(|e| e.to_string())?;
        kernel
            .arm(2, pool.wake.read_fd(), -1, 0)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            kernel,
            io: Default::default(),
            registrations: HashMap::new(),
            keys: HashMap::new(),
        })
    }
    fn remove(&mut self, token: u64) -> Option<Registration> {
        let registration = self.registrations.remove(&token)?;
        self.kernel.remove(token);
        self.keys.remove(&registration.key());
        if let Some(fd) = registration.change.borrowed_fd {
            mailbox().inner.lock().unwrap().borrowed_fds.remove(&fd);
        }
        Some(registration)
    }
    fn drain(&mut self) -> Result<(), String> {
        mailbox().drain_wake();
        self.io.drain(&mut self.kernel)?;
        let changes = std::mem::take(&mut mailbox().inner.lock().unwrap().changes);
        for change in changes {
            if change.cancel_owner.is_none()
                && !change.scheduler_wake
                && !change.scheduler_poll
                && !matches!(change.filter, -1 | -2 | -4 | -5 | -6 | -7)
            {
                return Err(format!(
                    "unsupported process readiness filter: {}",
                    change.filter
                ));
            }
            if let Some(owner) = change.cancel_owner {
                let tokens: Vec<_> = self
                    .registrations
                    .iter()
                    .filter(|(_, r)| r.owner() == owner)
                    .map(|(t, _)| *t)
                    .collect();
                for token in tokens {
                    self.remove(token);
                }
                continue;
            }
            let deadline = if change.filter == -7 || change.scheduler_poll {
                let duration = Duration::try_from_secs_f64((change.data / 1000.0).max(0.0))
                    .map_err(|_| "native timer delay is out of range")?;
                Some(
                    Instant::now()
                        .checked_add(duration)
                        .ok_or("native timer deadline is out of range")?,
                )
            } else {
                None
            };
            let registration = Registration { change, deadline };
            let owner = registration.owner();
            let key = registration.key();
            if let Some(token) = self.keys.get(&key).copied() {
                self.remove(token);
            }
            let change = &registration.change;
            if change.flags & 2 != 0 || !owner_pools().lock().unwrap().contains_key(&owner) {
                if let Some(fd) = change.borrowed_fd {
                    mailbox().inner.lock().unwrap().borrowed_fds.remove(&fd);
                }
                continue;
            }
            let token = next_handle() + 2;
            trace_readiness(
                change.trace_id,
                owner,
                "controller-received",
                change.ident,
                change.filter,
                change.udata,
            );
            if deadline.is_none() {
                let filter = if change.scheduler_wake {
                    -1
                } else {
                    change.filter
                };
                let result = self.kernel.arm(
                    token,
                    change.borrowed_fd.unwrap_or(change.ident as RawFd),
                    filter,
                    change.fflags,
                );
                if let Err(error) = result {
                    if filter == -5 && error.raw_os_error() == Some(libc::ESRCH) {
                        deliver(&registration, 0, 0, false);
                        continue;
                    }
                    return Err(format!(
                        "native readiness {filter} on {}: {error}",
                        change.ident
                    ));
                }
            }
            trace_readiness(
                change.trace_id,
                owner,
                "controller-installed",
                change.ident,
                change.filter,
                change.udata,
            );
            if matches!(change.filter, -4 | -6) {
                deliver(&registration, 0, 0, true);
            }
            self.keys.insert(key, token);
            self.registrations.insert(token, registration);
        }
        CONTROLLER_REGISTRATIONS.store(self.registrations.len() as u64, Ordering::Relaxed);
        Ok(())
    }
    fn tick(&mut self) -> Result<(), String> {
        self.drain()?;
        let now = Instant::now();
        let timeout = self
            .registrations
            .values()
            .filter_map(|r| r.deadline)
            .min()
            .map(|d| {
                d.saturating_duration_since(now)
                    .as_millis()
                    .min(i32::MAX as u128) as i32
            })
            .unwrap_or(-1);
        let events = self.kernel.wait(timeout).map_err(|e| e.to_string())?;
        // Apply cancellations before handling events obtained in the same batch.
        self.drain()?;
        for event in events {
            if event.token <= 2 {
                continue;
            }
            if event.token & crate::native_io::IO_TOKEN != 0 {
                if self.kernel.has_completion_io() {
                    self.io.completed(
                        &mut self.kernel,
                        event.token & !crate::native_io::IO_TOKEN,
                        event.data,
                    )?;
                } else {
                    self.io
                        .progress(&mut self.kernel, event.token & !crate::native_io::IO_TOKEN)?;
                }
                continue;
            }
            if let Some(registration) = self.registrations.get(&event.token) {
                deliver(registration, event.data, event.flags, false);
                if !registration.change.scheduler_wake
                    && !matches!(registration.change.filter, -4 | -6)
                {
                    self.remove(event.token);
                }
            }
        }
        let now = Instant::now();
        let due: Vec<_> = self
            .registrations
            .iter()
            .filter(|(_, r)| r.deadline.is_some_and(|d| d <= now))
            .map(|(t, _)| *t)
            .collect();
        for token in due {
            if let Some(registration) = self.remove(token) {
                deliver(&registration, 0, 0, false);
            }
        }
        Ok(())
    }
}

fn deliver(registration: &Registration, data: i64, flags: u32, installed: bool) {
    let owner = registration.owner();
    let change = &registration.change;
    if change.scheduler_wake || change.scheduler_poll {
        signal_owner(owner);
        return;
    }
    let owners = owner_pools().lock().unwrap();
    let Some(pool) = owners.get(&owner).and_then(Weak::upgrade) else {
        return;
    };
    let completion = [
        change.ident,
        change.filter as f64,
        0.0,
        flags as f64,
        data as f64,
        change.udata,
        if installed { 1.0 } else { 0.0 },
        change.trace_id as f64,
    ];
    mailbox()
        .inner
        .lock()
        .unwrap()
        .events
        .entry(owner)
        .or_default()
        .push(completion);
    trace_readiness(
        change.trace_id,
        owner,
        "routed",
        change.ident,
        change.filter,
        change.udata,
    );
    CONTROLLER_ROUTED.fetch_add(1, Ordering::Relaxed);
    pool.signal(owner);
}

fn wake_registration(owner: u32, fd: RawFd) -> Result<(), String> {
    let mut change = ReadinessChange::control(owner as f64, 0.0);
    change.ident = fd as f64;
    change.scheduler_wake = true;
    let mut mail = mailbox().inner.lock().unwrap();
    change.borrowed_fd = Some(mail.borrow_fd(fd).map_err(|e| e.to_string())?);
    mail.changes.push(change);
    drop(mail);
    mailbox().notify();
    Ok(())
}

pub(crate) fn run_command(process_env: ProcessEnv) -> Result<(), String> {
    let package_map_json =
        std::fs::read_to_string(process_env.root.join(".fino/package-map.json")).ok();
    let inner = PendingWorkloadInner {
        entry: "internal:scheduler/bootstrap".into(),
        process_env,
        package_map_json,
        import_rules: crate::state::default_import_rules(),
        channel_rx: None,
        channel_tx: None,
        wake_read_fd: None,
        wake_write_fd: None,
        watch_mode: false,
        repl_mode: false,
        realm_data: None,
        realm_bootstrap_data: None,
        reload_requested_signal: None,
        scheduled: None,
        port_fds: None,
        async_pipe: create_pipe()?,
    };
    run(inner)
}

pub(crate) fn run_process(config: crate::realm::child::ChildConfig) -> Result<(), String> {
    run(PendingWorkloadInner {
        entry: config.entry_path,
        process_env: config.process_env,
        package_map_json: config.package_map_json,
        import_rules: config.import_rules,
        channel_rx: Some(config.channel_rx),
        channel_tx: Some(config.channel_tx),
        wake_read_fd: Some(config.wake_read_fd),
        wake_write_fd: config.wake_write_fd,
        watch_mode: config.watch_mode,
        repl_mode: false,
        realm_data: config.realm_data,
        realm_bootstrap_data: config.realm_bootstrap_data,
        reload_requested_signal: config.reload_requested_signal,
        scheduled: None,
        port_fds: None,
        async_pipe: create_pipe()?,
    })
}

fn run(inner: PendingWorkloadInner) -> Result<(), String> {
    crate::runtime::init_v8();
    start_readiness_recorder();
    let pool = Arc::new(PoolShared::new());
    *process_pool().lock().unwrap() = Some(pool.clone());
    let mut driver = Driver::new(&pool)?;
    let owner = next_owner();
    let wake_fd = inner.async_pipe.0;
    let processors = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    let thread_count = reactor_count(
        processors,
        inner
            .process_env
            .env_vars
            .get("FINO_REACTOR_THREADS")
            .map(String::as_str),
    );
    realm_created(owner, 0, &inner.entry);
    pool.submit(PoolItem {
        owner,
        workload: PoolWorkload::Pending(PendingWorkload {
            owner,
            inner: Some(Box::new(inner)),
        }),
    });
    wake_registration(owner, wake_fd)?;
    let mut workers = Vec::new();
    // Publish the complete capacity before the command Realm can inspect it.
    let registrations: Vec<_> = (0..thread_count).map(|_| pool.register_worker()).collect();
    for (worker, wake) in registrations {
        let stop = Arc::new(AtomicBool::new(false));
        let (shared, thread_stop, thread_wake) = (pool.clone(), stop.clone(), wake.clone());
        let join = std::thread::spawn(move || run_worker(worker, shared, thread_stop, thread_wake));
        workers.push(ReactorThread {
            shared: pool.clone(),
            stop,
            wake,
            join: Some(join),
        });
    }
    let result = (|| {
        let mut error = None;
        let mut entry_finished = false;
        loop {
            pool.drain_wake();
            let finished = {
                let mut inner = pool.inner.lock().unwrap();
                for event in inner.events.drain(..) {
                    if event.owner == owner && matches!(event.kind, PoolEventKind::Error) {
                        error = event.error;
                    }
                    if event.owner == owner && !matches!(event.kind, PoolEventKind::Activated) {
                        entry_finished = true;
                    }
                }
                entry_finished && inner.parked.is_empty() && inner.residents.is_empty()
            };
            if finished || error.is_some() {
                return error.map_or(Ok(()), Err);
            }
            driver.tick()?;
        }
    })();
    {
        let mut inner = pool.inner.lock().unwrap();
        inner.shutdown = true;
        inner.wake_all();
    }
    {
        let mut isolates = isolates().lock().unwrap();
        isolates.stopping = true;
        for handle in isolates.handles.values() {
            handle.terminate_execution();
        }
    }
    for worker in &mut workers {
        worker.shutdown();
    }
    let pool = take_stopped_pool(process_pool()).map_err(str::to_string)?;
    let parked = std::mem::take(&mut pool.inner.lock().unwrap().parked);
    // Even disposal runs on a worker, never on the host main thread.
    std::thread::spawn(move || {
        for item in parked.into_values() {
            match item.workload {
                PoolWorkload::Live(w) => drop_workload(w.0),
                PoolWorkload::Pending(p) => drop(p),
            }
        }
    })
    .join()
    .map_err(|_| "Realm disposal failed".to_string())?;
    drop(driver);
    result
}

fn reactor_count(processors: usize, configured: Option<&str>) -> usize {
    configured
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|count| count.is_finite() && *count >= 1.0)
        .map(|count| count.floor() as usize)
        .unwrap_or(if processors <= 1 {
            1
        } else {
            (processors - 1).max(2)
        })
}

#[cfg(test)]
mod tests {
    use super::reactor_count;
    #[test]
    fn sizing_reserves_a_processor_and_honors_overrides() {
        for (processors, expected) in [(0, 1), (1, 1), (2, 2), (3, 2), (8, 7)] {
            assert_eq!(reactor_count(processors, None), expected);
        }
        assert_eq!(reactor_count(8, Some("4")), 4);
        assert_eq!(reactor_count(8, Some("4.9")), 4);
        assert_eq!(reactor_count(8, Some("NaN")), 7);
        assert_eq!(reactor_count(8, Some("0")), 7);
    }
}
