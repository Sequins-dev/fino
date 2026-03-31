//! Async context propagation for Boats.
//!
//! Provides `BoatsJobExecutor` — a custom Boa `JobExecutor` that:
//!
//! 1. Propagates context frames (async slot values) through `await` / `.then()`
//!    boundaries, giving JS-visible `Context` objects automatic propagation.
//!
//! 2. Tags every enqueued job with the current loop ID so jobs can be selectively
//!    drained per-loop. This is the foundation of per-loop microtask isolation:
//!    each event loop drains only its own promise reactions, leaving other loops'
//!    jobs queued until those loops drain them.
//!
//! Also exposes the `internal:async-context` synthetic module with the primitive
//! operations that `js/context.mjs` and `js/loop.mjs` build their APIs on top of.

use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap, VecDeque},
    mem,
    rc::Rc,
};

use boa_engine::{
    Context, JsError, JsNativeError, JsResult, JsValue, Module, NativeFunction,
    context::time::JsInstant,
    job::{GenericJob, Job, JobExecutor, NativeAsyncJob, PromiseJob, TimeoutJob},
    js_string,
    module::SyntheticModuleInitializer,
    object::FunctionObjectBuilder,
};
use futures_concurrency::future::FutureGroup;
use futures_lite::{StreamExt, future};

// ---------------------------------------------------------------------------
// Frame type
// ---------------------------------------------------------------------------

/// A snapshot of all context slot values at a point in time.
type Frame = Vec<Option<JsValue>>;

// ---------------------------------------------------------------------------
// AsyncContextStore
// ---------------------------------------------------------------------------

/// Holds the live context slot values and a table of named snapshots.
///
/// Each `Context` object created in JS allocates one slot here (via
/// `createSlot`). The executor captures and restores frames around each job.
pub struct AsyncContextStore {
    /// The current live slot values, indexed by slot ID.
    slots: RefCell<Frame>,
    /// Snapshot table: integer handle → captured frame.
    snapshots: RefCell<HashMap<u32, Frame>>,
    next_snapshot_id: Cell<u32>,
}

impl AsyncContextStore {
    pub fn new() -> Self {
        Self {
            slots: RefCell::new(Vec::new()),
            snapshots: RefCell::new(HashMap::new()),
            next_snapshot_id: Cell::new(0),
        }
    }

    /// Append a new slot (initially `None`) and return its index.
    pub fn create_slot(&self) -> u32 {
        let id = self.slots.borrow().len() as u32;
        self.slots.borrow_mut().push(None);
        id
    }

    /// Read the current value of a slot.
    pub fn get_slot(&self, id: u32) -> JsValue {
        self.slots
            .borrow()
            .get(id as usize)
            .and_then(|v| v.clone())
            .unwrap_or(JsValue::undefined())
    }

    /// Write a value to a slot.
    pub fn set_slot(&self, id: u32, value: JsValue) {
        let mut slots = self.slots.borrow_mut();
        if let Some(slot) = slots.get_mut(id as usize) {
            *slot = Some(value);
        }
    }

    /// Reset a slot to `None` (the "unset" / "cleared" state).
    pub fn clear_slot(&self, id: u32) {
        let mut slots = self.slots.borrow_mut();
        if let Some(slot) = slots.get_mut(id as usize) {
            *slot = None;
        }
    }

    /// Capture the current frame and return an integer handle.
    pub fn snapshot(&self) -> u32 {
        let id = self.next_snapshot_id.get();
        self.next_snapshot_id.set(id + 1);
        self.snapshots
            .borrow_mut()
            .insert(id, self.slots.borrow().clone());
        id
    }

    /// Restore the slots from a previously-captured snapshot handle.
    /// The snapshot remains in the table so it can be re-entered multiple times.
    pub fn restore(&self, id: u32) {
        if let Some(frame) = self.snapshots.borrow().get(&id).cloned() {
            *self.slots.borrow_mut() = frame;
        }
    }

    /// Clone the current slots for pairing with an enqueued job.
    fn capture(&self) -> Frame {
        self.slots.borrow().clone()
    }

    /// Atomically replace the slots with `frame`, returning the old frame.
    ///
    /// If `frame` is shorter than the current slots vector (because new slots
    /// were created via `create_slot` after this frame was captured), the slots
    /// vector is extended with `None` entries to preserve the newly allocated
    /// indices. This ensures that `create_slot` IDs remain valid across job
    /// boundaries even when the job was enqueued before those slots existed.
    fn install(&self, frame: Frame) -> Frame {
        let mut slots = self.slots.borrow_mut();
        let current_len = slots.len();
        let old = mem::replace(&mut *slots, frame);
        if slots.len() < current_len {
            slots.resize(current_len, None);
        }
        old
    }
}

// ---------------------------------------------------------------------------
// BoatsJobExecutor
// ---------------------------------------------------------------------------

/// A Boa `JobExecutor` that propagates context frames and loop tags.
///
/// Every enqueued job is paired with:
/// - A `Frame`: the async context slot snapshot at enqueue time (for Context propagation)
/// - An `Option<u32>`: the loop ID at enqueue time (for per-loop microtask draining)
///
/// The loop tag is set by JS via `enterLoop(id)` / `exitLoop(prev)` before/after
/// each iteration of a loop's spin. This allows `run_jobs_for_loop(id)` to drain
/// only the jobs belonging to a specific loop, leaving others queued.
pub struct BoatsJobExecutor {
    pub store: Rc<AsyncContextStore>,
    /// The loop ID currently "in scope" — captured by enqueue_job.
    current_loop_id: Cell<Option<u32>>,
    /// Monotonically increasing ID counter for allocating loop IDs.
    next_loop_id: Cell<u32>,
    promise_jobs: RefCell<VecDeque<(PromiseJob, Frame, Option<u32>)>>,
    async_jobs: RefCell<VecDeque<(NativeAsyncJob, Frame, Option<u32>)>>,
    #[allow(clippy::type_complexity)]
    timeout_jobs: RefCell<BTreeMap<JsInstant, (TimeoutJob, Frame, Option<u32>)>>,
    generic_jobs: RefCell<VecDeque<(GenericJob, Frame, Option<u32>)>>,
    /// JS callback registered by `internal:loader` for filesystem path resolution.
    /// Stored here (on the executor) so Boa's GC can trace the `JsObject` reference.
    pub resolve_fn: RefCell<Option<boa_engine::JsObject>>,
    /// JS callback registered by `internal:loader` for populating `import.meta`.
    pub init_meta_fn: RefCell<Option<boa_engine::JsObject>>,
}

impl BoatsJobExecutor {
    pub fn new(store: Rc<AsyncContextStore>) -> Self {
        Self {
            store,
            current_loop_id: Cell::new(None),
            next_loop_id: Cell::new(0),
            promise_jobs: RefCell::new(VecDeque::new()),
            async_jobs: RefCell::new(VecDeque::new()),
            timeout_jobs: RefCell::new(BTreeMap::new()),
            generic_jobs: RefCell::new(VecDeque::new()),
            resolve_fn: RefCell::new(None),
            init_meta_fn: RefCell::new(None),
        }
    }

    fn clear(&self) {
        self.promise_jobs.borrow_mut().clear();
        self.async_jobs.borrow_mut().clear();
        self.timeout_jobs.borrow_mut().clear();
        self.generic_jobs.borrow_mut().clear();
    }

    /// Allocate a fresh loop ID. Called once per `loop.create()`.
    pub fn create_loop_id(&self) -> u32 {
        let id = self.next_loop_id.get();
        self.next_loop_id.set(id + 1);
        id
    }

    /// Set the current loop ID for job tagging. Returns the previous value so
    /// the caller can restore it (enabling nested loop scopes).
    pub fn enter_loop(&self, id: u32) -> Option<u32> {
        self.current_loop_id.replace(Some(id))
    }

    /// Restore the loop ID to a previous value returned by `enter_loop`.
    pub fn exit_loop(&self, prev: Option<u32>) {
        self.current_loop_id.set(prev);
    }

    /// Returns true if there are any pending jobs tagged with `loop_id`.
    pub fn has_loop_work(&self, loop_id: u32) -> bool {
        let target = Some(loop_id);
        self.promise_jobs
            .borrow()
            .iter()
            .any(|(_, _, id)| *id == target)
            || self
                .async_jobs
                .borrow()
                .iter()
                .any(|(_, _, id)| *id == target)
            || self
                .generic_jobs
                .borrow()
                .iter()
                .any(|(_, _, id)| *id == target)
            || self
                .timeout_jobs
                .borrow()
                .values()
                .any(|(_, _, id)| *id == target)
    }

    /// Drain only jobs tagged with `loop_id`, leaving all other jobs queued.
    ///
    /// This is the per-loop counterpart to `run_jobs`. It runs until no more
    /// jobs tagged with `loop_id` remain. Jobs with a different tag (including
    /// `None`) are untouched.
    ///
    /// On error, only jobs from this loop are cleared; other loops' jobs survive.
    pub fn run_jobs_for_loop(self: Rc<Self>, loop_id: u32, context: &mut Context) -> JsResult<()> {
        future::block_on(self.run_jobs_for_loop_async(loop_id, &RefCell::new(context)))
    }

    async fn run_jobs_for_loop_async(
        self: Rc<Self>,
        loop_id: u32,
        context: &RefCell<&mut Context>,
    ) -> JsResult<()>
    where
        Self: Sized,
    {
        let target = Some(loop_id);
        let mut group: FutureGroup<_> = FutureGroup::new();

        loop {
            // Kick off async jobs tagged with this loop.
            {
                let all = mem::take(&mut *self.async_jobs.borrow_mut());
                let mut to_keep = VecDeque::with_capacity(all.len());
                for (job, frame, id) in all {
                    if id == target {
                        let prev = self.store.install(frame);
                        let fut = job.call(context);
                        self.store.install(prev);
                        group.insert(fut);
                    } else {
                        to_keep.push_back((job, frame, id));
                    }
                }
                *self.async_jobs.borrow_mut() = to_keep;
            }

            let has_matching_timeout = {
                let now = context.borrow().clock().now();
                self.timeout_jobs
                    .borrow()
                    .iter()
                    .any(|(t, (_, _, id))| &now >= t && *id == target)
            };

            let has_matching_promise = self
                .promise_jobs
                .borrow()
                .iter()
                .any(|(_, _, id)| *id == target);

            let has_matching_generic = self
                .generic_jobs
                .borrow()
                .iter()
                .any(|(_, _, id)| *id == target);

            if !has_matching_promise
                && !has_matching_generic
                && !has_matching_timeout
                && group.is_empty()
            {
                break;
            }

            if let Some(Err(err)) = future::poll_once(group.next()).await.flatten() {
                self.clear_loop(loop_id);
                return Err(err);
            }

            // Run matured timeout jobs for this loop.
            {
                let now = context.borrow().clock().now();
                let mut timeouts = self.timeout_jobs.borrow_mut();
                let all: BTreeMap<_, _> = mem::take(&mut *timeouts);
                let mut to_run = Vec::new();
                let mut to_keep = BTreeMap::new();
                for (deadline, (job, frame, id)) in all {
                    if id == target && now >= deadline && !job.is_cancelled() {
                        to_run.push((job, frame));
                    } else {
                        to_keep.insert(deadline, (job, frame, id));
                    }
                }
                *timeouts = to_keep;
                drop(timeouts);

                for (job, frame) in to_run {
                    let prev = self.store.install(frame);
                    let result = job.call(&mut context.borrow_mut());
                    self.store.install(prev);
                    if let Err(err) = result {
                        self.clear_loop(loop_id);
                        return Err(err);
                    }
                }
            }

            // Run promise jobs for this loop.
            {
                let all = mem::take(&mut *self.promise_jobs.borrow_mut());
                let mut to_keep = VecDeque::with_capacity(all.len());
                let mut to_run = Vec::new();
                for (job, frame, id) in all {
                    if id == target {
                        to_run.push((job, frame));
                    } else {
                        to_keep.push_back((job, frame, id));
                    }
                }
                *self.promise_jobs.borrow_mut() = to_keep;

                for (job, frame) in to_run {
                    let prev = self.store.install(frame);
                    let result = job.call(&mut context.borrow_mut());
                    self.store.install(prev);
                    if let Err(err) = result {
                        self.clear_loop(loop_id);
                        return Err(err);
                    }
                }
            }

            // Run generic jobs for this loop.
            {
                let all = mem::take(&mut *self.generic_jobs.borrow_mut());
                let mut to_keep = VecDeque::with_capacity(all.len());
                let mut to_run = Vec::new();
                for (job, frame, id) in all {
                    if id == target {
                        to_run.push((job, frame));
                    } else {
                        to_keep.push_back((job, frame, id));
                    }
                }
                *self.generic_jobs.borrow_mut() = to_keep;

                for (job, frame) in to_run {
                    let prev = self.store.install(frame);
                    let result = job.call(&mut context.borrow_mut());
                    self.store.install(prev);
                    if let Err(err) = result {
                        self.clear_loop(loop_id);
                        return Err(err);
                    }
                }
            }

            context.borrow_mut().clear_kept_objects();
            future::yield_now().await;
        }

        Ok(())
    }

    /// Clear all pending jobs tagged with `loop_id` (e.g. on error).
    /// Other loops' jobs are unaffected.
    fn clear_loop(&self, loop_id: u32) {
        let target = Some(loop_id);
        self.promise_jobs
            .borrow_mut()
            .retain(|(_, _, id)| *id != target);
        self.async_jobs
            .borrow_mut()
            .retain(|(_, _, id)| *id != target);
        self.generic_jobs
            .borrow_mut()
            .retain(|(_, _, id)| *id != target);
        self.timeout_jobs
            .borrow_mut()
            .retain(|_, (_, _, id)| *id != target);
    }
}

impl JobExecutor for BoatsJobExecutor {
    fn enqueue_job(self: Rc<Self>, job: Job, context: &mut Context) {
        let frame = self.store.capture();
        let loop_id = self.current_loop_id.get();
        match job {
            Job::PromiseJob(p) => self
                .promise_jobs
                .borrow_mut()
                .push_back((p, frame, loop_id)),
            Job::AsyncJob(a) => self.async_jobs.borrow_mut().push_back((a, frame, loop_id)),
            Job::TimeoutJob(t) => {
                let now = context.clock().now();
                let deadline = now + t.timeout();
                self.timeout_jobs
                    .borrow_mut()
                    .insert(deadline, (t, frame, loop_id));
            }
            Job::GenericJob(g) => self
                .generic_jobs
                .borrow_mut()
                .push_back((g, frame, loop_id)),
            // Job is #[non_exhaustive]
            _ => {}
        }
    }

    fn run_jobs(self: Rc<Self>, context: &mut Context) -> JsResult<()> {
        future::block_on(self.run_jobs_async(&RefCell::new(context)))
    }

    async fn run_jobs_async(self: Rc<Self>, context: &RefCell<&mut Context>) -> JsResult<()>
    where
        Self: Sized,
    {
        let mut group: FutureGroup<_> = FutureGroup::new();

        loop {
            // Kick off async jobs. Restore the enqueued frame before calling
            // .call() so the async closure captures the right context.
            for (job, frame, _) in mem::take(&mut *self.async_jobs.borrow_mut()) {
                let prev = self.store.install(frame);
                let fut = job.call(context);
                self.store.install(prev);
                group.insert(fut);
            }

            let no_timeout_jobs = {
                let now = context.borrow().clock().now();
                !self.timeout_jobs.borrow().iter().any(|(t, _)| &now >= t)
            };

            if self.promise_jobs.borrow().is_empty()
                && self.async_jobs.borrow().is_empty()
                && self.generic_jobs.borrow().is_empty()
                && no_timeout_jobs
                && group.is_empty()
            {
                break;
            }

            if let Some(Err(err)) = future::poll_once(group.next()).await.flatten() {
                self.clear();
                return Err(err);
            }

            // Run matured timeout jobs.
            {
                let now = context.borrow().clock().now();
                let mut timeouts = self.timeout_jobs.borrow_mut();
                let mut to_keep = timeouts.split_off(&now);
                to_keep.retain(|_, (job, _, _)| !job.is_cancelled());
                let ready = mem::replace(&mut *timeouts, to_keep);
                drop(timeouts);

                for (_, (job, frame, _)) in ready {
                    let prev = self.store.install(frame);
                    let result = job.call(&mut context.borrow_mut());
                    self.store.install(prev);
                    if let Err(err) = result {
                        self.clear();
                        return Err(err);
                    }
                }
            }

            // Run promise jobs.
            let promise_jobs = mem::take(&mut *self.promise_jobs.borrow_mut());
            for (job, frame, _) in promise_jobs {
                let prev = self.store.install(frame);
                let result = job.call(&mut context.borrow_mut());
                self.store.install(prev);
                if let Err(err) = result {
                    self.clear();
                    return Err(err);
                }
            }

            // Run generic jobs.
            let generic_jobs = mem::take(&mut *self.generic_jobs.borrow_mut());
            for (job, frame, _) in generic_jobs {
                let prev = self.store.install(frame);
                let result = job.call(&mut context.borrow_mut());
                self.store.install(prev);
                if let Err(err) = result {
                    self.clear();
                    return Err(err);
                }
            }

            context.borrow_mut().clear_kept_objects();
            future::yield_now().await;
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// internal:async-context synthetic module
// ---------------------------------------------------------------------------

/// Build the `internal:async-context` synthetic module.
///
/// Context slot exports (backed by `AsyncContextStore`):
/// - `createSlot() -> u32`           allocate a new context slot
/// - `getSlot(id: u32) -> any`       read the current value of a slot
/// - `setSlot(id: u32, value: any)`  write a value to a slot
/// - `clearSlot(id: u32)`            reset a slot to the unset state
/// - `snapshot() -> u32`             capture current frame, return handle
/// - `restore(handle: u32)`          restore frame from handle
///
/// Loop execution exports (backed by `BoatsJobExecutor`):
/// - `createLoopId() -> u32`         allocate a fresh loop tag
/// - `enterLoop(id: u32) -> u32?`    set ambient loop tag, return previous
/// - `exitLoop(prev: u32?)`          restore previous ambient loop tag
/// - `drainLoopMicrotasks(id: u32)`  drain only jobs tagged with `id`
/// - `hasLoopWork(id: u32) -> bool`  true if any jobs are tagged with `id`
/// - `drainMicrotasks()`             global drain — all queued jobs regardless of loop tag
pub fn create_module(context: &mut Context) -> JsResult<Module> {
    let module = Module::synthetic(
        &[
            js_string!("createSlot"),
            js_string!("getSlot"),
            js_string!("setSlot"),
            js_string!("clearSlot"),
            js_string!("snapshot"),
            js_string!("restore"),
            js_string!("createLoopId"),
            js_string!("enterLoop"),
            js_string!("exitLoop"),
            js_string!("drainLoopMicrotasks"),
            js_string!("hasLoopWork"),
            js_string!("drainMicrotasks"),
        ],
        SyntheticModuleInitializer::from_copy_closure(|module, context| {
            // --- Context slot functions ---

            let create_slot = FunctionObjectBuilder::new(
                context.realm(),
                NativeFunction::from_fn_ptr(|_, _, context| {
                    Ok(JsValue::from(get_store(context)?.create_slot()))
                }),
            )
            .name(js_string!("createSlot"))
            .length(0)
            .build();

            let get_slot = FunctionObjectBuilder::new(
                context.realm(),
                NativeFunction::from_fn_ptr(|_, args, context| {
                    let id = slot_id_arg(args, "getSlot")?;
                    Ok(get_store(context)?.get_slot(id))
                }),
            )
            .name(js_string!("getSlot"))
            .length(1)
            .build();

            let set_slot = FunctionObjectBuilder::new(
                context.realm(),
                NativeFunction::from_fn_ptr(|_, args, context| {
                    let id = slot_id_arg(args, "setSlot")?;
                    let value = args.get(1).cloned().unwrap_or(JsValue::undefined());
                    get_store(context)?.set_slot(id, value);
                    Ok(JsValue::undefined())
                }),
            )
            .name(js_string!("setSlot"))
            .length(2)
            .build();

            let clear_slot = FunctionObjectBuilder::new(
                context.realm(),
                NativeFunction::from_fn_ptr(|_, args, context| {
                    let id = slot_id_arg(args, "clearSlot")?;
                    get_store(context)?.clear_slot(id);
                    Ok(JsValue::undefined())
                }),
            )
            .name(js_string!("clearSlot"))
            .length(1)
            .build();

            let snapshot = FunctionObjectBuilder::new(
                context.realm(),
                NativeFunction::from_fn_ptr(|_, _, context| {
                    Ok(JsValue::from(get_store(context)?.snapshot()))
                }),
            )
            .name(js_string!("snapshot"))
            .length(0)
            .build();

            let restore = FunctionObjectBuilder::new(
                context.realm(),
                NativeFunction::from_fn_ptr(|_, args, context| {
                    let id = slot_id_arg(args, "restore")?;
                    get_store(context)?.restore(id);
                    Ok(JsValue::undefined())
                }),
            )
            .name(js_string!("restore"))
            .length(1)
            .build();

            // --- Loop execution functions ---

            let create_loop_id = FunctionObjectBuilder::new(
                context.realm(),
                NativeFunction::from_fn_ptr(|_, _, context| {
                    Ok(JsValue::from(get_executor(context)?.create_loop_id()))
                }),
            )
            .name(js_string!("createLoopId"))
            .length(0)
            .build();

            let enter_loop = FunctionObjectBuilder::new(
                context.realm(),
                NativeFunction::from_fn_ptr(|_, args, context| {
                    let id = slot_id_arg(args, "enterLoop")?;
                    let prev = get_executor(context)?.enter_loop(id);
                    Ok(prev.map(JsValue::from).unwrap_or(JsValue::undefined()))
                }),
            )
            .name(js_string!("enterLoop"))
            .length(1)
            .build();

            let exit_loop = FunctionObjectBuilder::new(
                context.realm(),
                NativeFunction::from_fn_ptr(|_, args, context| {
                    // prev is undefined (no loop) or a u32 loop ID
                    let prev = args.first().and_then(|v| v.as_number()).map(|n| n as u32);
                    get_executor(context)?.exit_loop(prev);
                    Ok(JsValue::undefined())
                }),
            )
            .name(js_string!("exitLoop"))
            .length(1)
            .build();

            let drain_loop_microtasks = FunctionObjectBuilder::new(
                context.realm(),
                NativeFunction::from_fn_ptr(|_, args, context| {
                    let id = slot_id_arg(args, "drainLoopMicrotasks")?;
                    get_executor(context)?
                        .run_jobs_for_loop(id, context)
                        .map_err(|e| {
                            JsError::from(
                                JsNativeError::error()
                                    .with_message(format!("drainLoopMicrotasks: {e}")),
                            )
                        })?;
                    Ok(JsValue::undefined())
                }),
            )
            .name(js_string!("drainLoopMicrotasks"))
            .length(1)
            .build();

            let has_loop_work = FunctionObjectBuilder::new(
                context.realm(),
                NativeFunction::from_fn_ptr(|_, args, context| {
                    let id = slot_id_arg(args, "hasLoopWork")?;
                    Ok(JsValue::from(get_executor(context)?.has_loop_work(id)))
                }),
            )
            .name(js_string!("hasLoopWork"))
            .length(1)
            .build();

            let drain_microtasks = FunctionObjectBuilder::new(
                context.realm(),
                NativeFunction::from_fn_ptr(|_, _, context| {
                    context.run_jobs().map_err(|e| {
                        JsError::from(
                            JsNativeError::error().with_message(format!("drainMicrotasks: {e}")),
                        )
                    })?;
                    Ok(JsValue::undefined())
                }),
            )
            .name(js_string!("drainMicrotasks"))
            .length(0)
            .build();

            module.set_export(&js_string!("createSlot"), create_slot.into())?;
            module.set_export(&js_string!("getSlot"), get_slot.into())?;
            module.set_export(&js_string!("setSlot"), set_slot.into())?;
            module.set_export(&js_string!("clearSlot"), clear_slot.into())?;
            module.set_export(&js_string!("snapshot"), snapshot.into())?;
            module.set_export(&js_string!("restore"), restore.into())?;
            module.set_export(&js_string!("createLoopId"), create_loop_id.into())?;
            module.set_export(&js_string!("enterLoop"), enter_loop.into())?;
            module.set_export(&js_string!("exitLoop"), exit_loop.into())?;
            module.set_export(
                &js_string!("drainLoopMicrotasks"),
                drain_loop_microtasks.into(),
            )?;
            module.set_export(&js_string!("hasLoopWork"), has_loop_work.into())?;
            module.set_export(&js_string!("drainMicrotasks"), drain_microtasks.into())?;
            Ok(())
        }),
        None,
        None,
        context,
    );

    Ok(module)
}

/// Retrieve the `AsyncContextStore` from the current context's job executor.
fn get_store(context: &mut Context) -> JsResult<Rc<AsyncContextStore>> {
    context
        .downcast_job_executor::<BoatsJobExecutor>()
        .map(|exec| exec.store.clone())
        .ok_or_else(|| {
            JsNativeError::error()
                .with_message("internal:async-context requires BoatsJobExecutor")
                .into()
        })
}

/// Retrieve the `BoatsJobExecutor` itself (for loop execution operations).
fn get_executor(context: &mut Context) -> JsResult<Rc<BoatsJobExecutor>> {
    context
        .downcast_job_executor::<BoatsJobExecutor>()
        .ok_or_else(|| {
            JsNativeError::error()
                .with_message("internal:async-context requires BoatsJobExecutor")
                .into()
        })
}

/// Extract a `u32` slot / handle id from the first argument.
fn slot_id_arg(args: &[JsValue], fn_name: &str) -> JsResult<u32> {
    args.first()
        .and_then(|v| v.as_number())
        .map(|n| n as u32)
        .ok_or_else(|| {
            JsNativeError::typ()
                .with_message(format!("{fn_name}: expected u32 argument"))
                .into()
        })
}
