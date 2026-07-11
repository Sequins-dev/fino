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
//! `scheduler_native`; this module contains their shared bridge, serializer,
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

// Public re-exports used by loader.rs.
pub use bridge::create_module as create_realm_bridge_module;
pub use native::create_module as create_realm_native_module;
