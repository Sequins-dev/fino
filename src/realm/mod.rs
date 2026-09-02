//! Realm transport and child-realm support modules.
//!
//! Exposes two synthetic modules:
//!
//! - `internal:realm-bridge` — readable from within a child Realm context;
//!   provides the entry path and termination flag stored in the child's
//!   FinoState.
//!
//! - `internal:realm-native` — callable from a parent realm; creates and drives
//!   process-sandbox realms.
//!
//! Reactor-pooled realms — the default — are owned by `scheduler_native`, which
//! creates each one as its own movable V8 isolate rather than a child context of
//! its parent. The modules here cover the transports those realms communicate
//! over and the process-sandbox execution mode.

pub mod bridge;
pub mod broadcast;
pub mod bytes;
pub mod child;
pub mod message;
pub mod native;
pub mod process;
pub mod serializer;
pub mod synthetic;
pub mod thread;
pub mod transit;

// Public re-exports used by loader.rs (BUILTINS registry).
pub use bridge::create_module as create_realm_bridge_module;
pub use native::create_module as create_realm_native_module;
