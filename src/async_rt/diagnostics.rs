//! Opt-in scalar observations of the native async bridge. No V8 handles are
//! retained, and snapshots never enter an isolate or signal its event loop.
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

#[derive(Clone, serde::Serialize)]
struct Operation {
    id: u64,
    owner: u32,
    kind: String,
    label: String,
    stage: String,
    started_us: u64,
    updated_us: u64,
}

#[derive(Default)]
struct Ledger {
    next: u64,
    dropped: u64,
    active: HashMap<u64, Operation>,
    recent: VecDeque<Operation>,
}

fn ledger() -> &'static Mutex<Ledger> {
    static LEDGER: OnceLock<Mutex<Ledger>> = OnceLock::new();
    LEDGER.get_or_init(|| Mutex::new(Ledger::default()))
}

fn now() -> u64 {
    crate::scheduler_native::readiness_trace_elapsed_us()
}

pub fn begin(owner: u32, kind: &str, label: &str) -> u64 {
    if !crate::scheduler_native::readiness_trace_enabled() {
        return 0;
    }
    let mut ledger = ledger().lock().unwrap();
    if ledger.active.len() == 65_536 {
        ledger.dropped += 1;
        return 0;
    }
    ledger.next += 1;
    let id = ledger.next;
    let time = now();
    ledger.active.insert(
        id,
        Operation {
            id,
            owner,
            kind: kind.into(),
            label: label.chars().take(256).collect(),
            stage: "queued".into(),
            started_us: time,
            updated_us: time,
        },
    );
    id
}

pub fn stage(id: u64, stage: &str) {
    if id == 0 {
        return;
    }
    if let Some(op) = ledger().lock().unwrap().active.get_mut(&id) {
        op.stage = stage.into();
        op.updated_us = now();
    }
}

pub fn finish(id: u64, stage: &str) {
    if id == 0 {
        return;
    }
    let mut ledger = ledger().lock().unwrap();
    if let Some(mut op) = ledger.active.remove(&id) {
        op.stage = stage.into();
        op.updated_us = now();
        if ledger.recent.len() == 512 {
            ledger.recent.pop_front();
        }
        ledger.recent.push_back(op);
    }
}

pub fn snapshot(owner: Option<u32>) -> serde_json::Value {
    let ledger = ledger().lock().unwrap();
    serde_json::json!({
        "elapsed_us": now(), "dropped": ledger.dropped,
        "active": ledger.active.values().filter(|op| owner.is_none_or(|owner| op.owner == owner)).collect::<Vec<_>>(),
        "recent": ledger.recent.iter().filter(|op| owner.is_none_or(|owner| op.owner == owner)).collect::<Vec<_>>()
    })
}
