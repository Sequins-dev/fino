//! Realm bootstrap, process isolation, messaging, and synthetic modules.
//!
//! Exposes two synthetic modules:
//!
//! - `internal:realm-bridge` — readable from within a child Realm context;
//!   provides the entry path and termination flag stored in the child's FinoState.
//!
//! - `internal:realm-native` — parent-side import-rule and process-isolation
//!   operations.
//!
//! Ordinary realms are constructed and owned by reactor engines in
//! `reactor::workload`; this module contains their shared bridge, serializer,
//! transit-port, broadcast, and synthetic-module support. Process-isolated
//! realms reuse the bootstrap through `child` and bridge their transit channel
//! over a Unix socket.

pub mod bridge;
pub mod broadcast;
pub mod child;
pub mod message;
pub mod native;
pub mod process;
pub mod serializer;
pub mod synthetic;
pub mod transit;

use std::os::unix::io::RawFd;

/// Placement-independent inputs for constructing one Realm execution
/// container. Process and reactor hosts add only their scheduling/IPC policy.
pub(crate) struct RealmExecutionConfig {
    pub process_env: crate::state::ProcessEnv,
    pub package_map_json: Option<String>,
    pub import_rules: Vec<crate::state::ImportRule>,
    pub entry_path: String,
    pub port_half: (u32, RawFd),
    pub allocation_half: Option<(u32, RawFd)>,
    pub timing_label: &'static str,
    pub watch_mode: bool,
    pub repl_mode: bool,
    pub realm_data: Option<String>,
    pub realm_bootstrap_data: Option<String>,
    pub heap_limit_bytes: usize,
}

// Public re-exports used by loader.rs.
pub use bridge::create_module as create_realm_bridge_module;
pub use native::create_module as create_realm_native_module;
