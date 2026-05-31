//! `internal:inspector` — generic V8 inspector binding.
//!
//! Exposes the Chrome DevTools Protocol over a per-realm inspector session.
//! The REPL is the primary consumer; future debugger/profiler features share
//! the same session via the raw `dispatch` / `onMessage` interface.
//!
//! JS exports:
//! - `dispatch(json: string): void` — send a CDP message to the session.
//! - `onMessage(handler: (json: string) => void): void` — register a listener
//!   for CDP responses and notifications.
//! - `nextId(): number` — monotonic message id helper.
//! - `evaluate(code, options?): Promise<unknown>` — convenience wrapper that
//!   sends `Runtime.evaluate` with `replMode: true, awaitPromise: true` and
//!   resolves/rejects the returned Promise when the inspector sends the result.

use std::cell::RefCell;
use std::ffi::c_void;
use std::ptr::addr_of;
use std::rc::Rc;

use ::v8;
use ::v8::inspector::{
    ChannelBase, ChannelImpl, StringView, V8InspectorClientBase, V8InspectorClientImpl,
    V8InspectorClientTrustLevel,
};

use crate::async_rt::bridge::{JsValueRepr, PendingResolution};
use crate::state::get_state;

// ---------------------------------------------------------------------------
// PendingEval — shared state for an in-flight evaluate() call
// ---------------------------------------------------------------------------

struct PendingEval {
    call_id: i32,
    resolver: v8::Global<v8::PromiseResolver>,
    pending_resolutions: Rc<RefCell<Vec<PendingResolution>>>,
}

// ---------------------------------------------------------------------------
// InspectorChannel — receives CDP responses and notifications from V8
// ---------------------------------------------------------------------------

struct InspectorChannel {
    base: ChannelBase,
    /// Pending evaluate() call waiting for its response.
    pending_eval: Rc<RefCell<Option<PendingEval>>>,
    /// CDP messages buffered since the last drain; routed to the JS handler.
    buffered_messages: RefCell<Vec<String>>,
    /// Context ID captured from Runtime.executionContextCreated notification.
    /// Initialized to -1; set when Runtime.enable is dispatched.
    context_id: std::cell::Cell<i32>,
}

impl ChannelImpl for InspectorChannel {
    fn base(&self) -> &ChannelBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut ChannelBase {
        &mut self.base
    }
    unsafe fn base_ptr(this: *const Self) -> *const ChannelBase
    where
        Self: Sized,
    {
        unsafe { addr_of!((*this).base) }
    }

    fn send_response(
        &mut self,
        call_id: i32,
        mut message: v8::UniquePtr<v8::inspector::StringBuffer>,
    ) {
        let json = message.as_mut().unwrap().string().to_string();
        // Resolve a pending evaluate() if the call_id matches.
        {
            let mut slot = self.pending_eval.borrow_mut();
            if slot.as_ref().map_or(false, |e| e.call_id == call_id) {
                let eval = slot.take().unwrap();
                eval.pending_resolutions.borrow_mut().push(PendingResolution {
                    resolver: eval.resolver,
                    result: Ok(JsValueRepr::String(json.clone())),
                });
            }
        }
        self.buffered_messages.borrow_mut().push(json);
    }

    fn send_notification(&mut self, mut message: v8::UniquePtr<v8::inspector::StringBuffer>) {
        let json = message.as_mut().unwrap().string().to_string();
        // Capture context_id from Runtime.executionContextCreated notification.
        if self.context_id.get() < 0 && json.contains("executionContextCreated") {
            if let Some(id) = extract_context_id(&json) {
                self.context_id.set(id);
            }
        }
        self.buffered_messages.borrow_mut().push(json);
    }

    fn flush_protocol_notifications(&mut self) {}
}

/// Extract `params.context.id` from a `Runtime.executionContextCreated` JSON notification.
/// Uses a simple string scan to avoid pulling in a JSON parser.
fn extract_context_id(json: &str) -> Option<i32> {
    // Look for `"id":N` after `"context":{`, being careful not to pick up other `"id"` fields.
    // The notification looks like: {"method":"Runtime.executionContextCreated","params":{"context":{"id":N,...}}}
    let ctx_pos = json.find("\"context\":")?;
    let after_ctx = &json[ctx_pos..];
    let id_pos = after_ctx.find("\"id\":")?;
    let after_id = &after_ctx[id_pos + 5..]; // skip `"id":`
    let trimmed = after_id.trim_start_matches(' ');
    // Read digits (possibly negative, though context IDs are positive)
    let end = trimmed.find(|c: char| !c.is_ascii_digit()).unwrap_or(trimmed.len());
    trimmed[..end].parse::<i32>().ok()
}

// ---------------------------------------------------------------------------
// InspectorClient — minimal V8InspectorClient implementation
// ---------------------------------------------------------------------------

struct InspectorClient {
    base: V8InspectorClientBase,
}

impl V8InspectorClientImpl for InspectorClient {
    fn base(&self) -> &V8InspectorClientBase {
        &self.base
    }
    fn base_mut(&mut self) -> &mut V8InspectorClientBase {
        &mut self.base
    }
    unsafe fn base_ptr(this: *const Self) -> *const V8InspectorClientBase
    where
        Self: Sized,
    {
        unsafe { addr_of!((*this).base) }
    }
}

// ---------------------------------------------------------------------------
// InspectorState — all inspector objects for one realm
// ---------------------------------------------------------------------------

pub struct InspectorState {
    client: Box<InspectorClient>,
    channel: Box<InspectorChannel>,
    // Dropped in declaration order: session first, then inspector, then client/channel.
    // We use Option so we can take() them in the correct order during Drop.
    session: Option<v8::UniqueRef<v8::inspector::V8InspectorSession>>,
    inspector: Option<v8::UniqueRef<v8::inspector::V8Inspector>>,
    next_id: std::cell::Cell<i32>,
    pending_eval: Rc<RefCell<Option<PendingEval>>>,
    message_handler: Option<v8::Global<v8::Function>>,
}

impl Drop for InspectorState {
    fn drop(&mut self) {
        // Session must be dropped before inspector (session references inspector resources).
        self.session.take();
        self.inspector.take();
    }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/// Dispose inspector state created by this module. Called during realm teardown.
///
/// # Safety
/// `ptr` must be a valid `*mut InspectorState` obtained from `Box::into_raw`,
/// and must not be used again after this call.
pub unsafe fn dispose_inspector(ptr: *mut c_void) {
    if !ptr.is_null() {
        unsafe { drop(Box::from_raw(ptr as *mut InspectorState)) };
    }
}

// ---------------------------------------------------------------------------
// Lazy inspector initialisation
// ---------------------------------------------------------------------------

fn get_or_init_inspector(scope: &mut v8::HandleScope) -> *mut InspectorState {
    let state_rc = get_state(scope);

    // Fast path: already initialised.
    if let Some(ptr) = state_rc.borrow().inspector_state {
        return ptr as *mut InspectorState;
    }

    let pending_eval: Rc<RefCell<Option<PendingEval>>> = Rc::new(RefCell::new(None));

    let mut client = Box::new(InspectorClient {
        base: V8InspectorClientBase::new::<InspectorClient>(),
    });
    let mut channel = Box::new(InspectorChannel {
        base: ChannelBase::new::<InspectorChannel>(),
        pending_eval: Rc::clone(&pending_eval),
        buffered_messages: RefCell::new(Vec::new()),
        context_id: std::cell::Cell::new(-1),
    });

    let context_group_id = 1i32;
    let context = scope.get_current_context();

    // V8Inspector::create takes &mut Isolate; HandleScope coerces via AsMut.
    let mut inspector =
        v8::inspector::V8Inspector::create(scope.as_mut(), &mut *client);

    let name_bytes = b"realm" as &[u8];
    let aux_bytes = b"{}" as &[u8];
    inspector.context_created(
        context,
        context_group_id,
        StringView::from(name_bytes),
        StringView::from(aux_bytes),
    );

    let state_bytes = b"{}" as &[u8];
    let mut session = inspector.connect(
        context_group_id,
        &mut *channel,
        StringView::from(state_bytes),
        V8InspectorClientTrustLevel::FullyTrusted,
    );

    // Enable the Runtime domain so V8 tracks execution contexts.
    // Without this, Runtime.evaluate returns "Cannot find default execution context".
    let enable_msg = b"{\"id\":0,\"method\":\"Runtime.enable\"}";
    session.dispatch_protocol_message(StringView::from(enable_msg.as_ref()));
    // Discard the Runtime.enable response and executionContextCreated notifications —
    // the context_id has been captured in channel.context_id via send_notification.
    channel.buffered_messages.borrow_mut().clear();

    let insp = Box::new(InspectorState {
        client,
        channel,
        session: Some(session),
        inspector: Some(inspector),
        next_id: std::cell::Cell::new(1),
        pending_eval,
        message_handler: None,
    });

    let raw = Box::into_raw(insp) as *mut c_void;
    state_rc.borrow_mut().inspector_state = Some(raw);
    raw as *mut InspectorState
}

// ---------------------------------------------------------------------------
// Drain buffered messages to the JS onMessage handler
// ---------------------------------------------------------------------------

fn drain_messages(scope: &mut v8::HandleScope, insp: &mut InspectorState) {
    let handler = match &insp.message_handler {
        Some(h) => v8::Local::new(scope, h),
        None => {
            // No handler — just discard.
            insp.channel.buffered_messages.borrow_mut().clear();
            return;
        }
    };
    let msgs: Vec<String> = insp.channel.buffered_messages.borrow_mut().drain(..).collect();
    for msg in msgs {
        let s = match v8::String::new(scope, &msg) {
            Some(s) => s,
            None => continue,
        };
        let recv = v8::undefined(scope);
        let _ = handler.call(scope, recv.into(), &[s.into()]);
    }
}

// ---------------------------------------------------------------------------
// Synthetic module
// ---------------------------------------------------------------------------

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        "dispatch",
        "onMessage",
        "nextId",
        "evaluate",
    ]
    .iter()
    .map(|n| v8::String::new(scope, n).unwrap())
    .collect();

    let module_name = v8::String::new(scope, "internal:inspector").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };

    macro_rules! set_fn {
        ($name:expr, $cb:expr) => {{
            let tmpl = v8::FunctionTemplate::new(scope, $cb);
            let func = tmpl.get_function(scope)?;
            let key = v8::String::new(scope, $name)?;
            module.set_synthetic_module_export(scope, key, func.into())?;
        }};
    }

    set_fn!("dispatch", dispatch_cb);
    set_fn!("onMessage", on_message_cb);
    set_fn!("nextId", next_id_cb);
    set_fn!("evaluate", evaluate_cb);

    Some(v8::undefined(scope).into())
}

// ---------------------------------------------------------------------------
// dispatch(json: string): void
// ---------------------------------------------------------------------------

fn dispatch_cb(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let msg = match args.get(0).to_string(scope) {
        Some(s) => s.to_rust_string_lossy(scope),
        None => return,
    };

    let insp = get_or_init_inspector(scope);
    let insp = unsafe { &mut *insp };

    if let Some(session) = insp.session.as_mut() {
        session.dispatch_protocol_message(StringView::from(msg.as_bytes()));
    }

    drain_messages(scope, insp);
}

// ---------------------------------------------------------------------------
// onMessage(handler: (json: string) => void): void
// ---------------------------------------------------------------------------

fn on_message_cb(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let insp = get_or_init_inspector(scope);
    let insp = unsafe { &mut *insp };

    let arg = args.get(0);
    if arg.is_function() {
        if let Ok(func) = v8::Local::<v8::Function>::try_from(arg) {
            insp.message_handler = Some(v8::Global::new(scope, func));
        }
    } else {
        insp.message_handler = None;
    }
}

// ---------------------------------------------------------------------------
// nextId(): number
// ---------------------------------------------------------------------------

fn next_id_cb(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let insp = get_or_init_inspector(scope);
    let insp = unsafe { &mut *insp };

    let id = insp.next_id.get();
    insp.next_id.set(id + 1);
    rv.set(v8::Integer::new(scope, id).into());
}

// ---------------------------------------------------------------------------
// evaluate(code, options?): Promise<unknown>
//
// options: { replMode?: boolean, sourceName?: string, awaitPromise?: boolean }
//
// Resolves with the parsed result value; rejects with a JS Error on
// exception or compile error.
// ---------------------------------------------------------------------------

fn evaluate_cb(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let code = match args.get(0).to_string(scope) {
        Some(s) => s.to_rust_string_lossy(scope),
        None => {
            let msg = v8::String::new(scope, "evaluate: first argument must be a string").unwrap();
            let exc = v8::Exception::type_error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
    };

    // Parse options object.
    let opts = args.get(1);
    let (repl_mode, await_promise, source_name) = if opts.is_object() {
        if let Ok(obj) = v8::Local::<v8::Object>::try_from(opts) {
            let repl_key = v8::String::new(scope, "replMode").unwrap();
            let await_key = v8::String::new(scope, "awaitPromise").unwrap();
            let name_key = v8::String::new(scope, "sourceName").unwrap();

            let repl_val = obj.get(scope, repl_key.into());
            let await_val = obj.get(scope, await_key.into());
            let name_val = obj.get(scope, name_key.into());

            let repl = repl_val.map_or(true, |v| {
                if v.is_boolean() { v.boolean_value(scope) } else { true }
            });
            let await_p = await_val.map_or(true, |v| {
                if v.is_boolean() { v.boolean_value(scope) } else { true }
            });
            let name = name_val.and_then(|v| v.to_string(scope))
                .map(|s| s.to_rust_string_lossy(scope))
                .unwrap_or_default();
            (repl, await_p, name)
        } else {
            (true, true, String::new())
        }
    } else {
        (true, true, String::new())
    };

    let insp = get_or_init_inspector(scope);
    let insp = unsafe { &mut *insp };

    // Allocate call id.
    let call_id = insp.next_id.get();
    insp.next_id.set(call_id + 1);

    // Create a Promise resolver; store resolver + pending_resolutions Rc.
    let resolver = match v8::PromiseResolver::new(scope) {
        Some(r) => r,
        None => {
            let msg = v8::String::new(scope, "evaluate: failed to create resolver").unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
    };
    let promise = resolver.get_promise(scope);
    let global_resolver = v8::Global::new(scope, resolver);

    let pending_resolutions = Rc::clone(
        &get_state(scope).borrow().pending_resolutions,
    );

    *insp.pending_eval.borrow_mut() = Some(PendingEval {
        call_id,
        resolver: global_resolver,
        pending_resolutions,
    });

    // Build the Runtime.evaluate CDP message.
    let source_name_json = if source_name.is_empty() {
        "\"<repl>\"".to_string()
    } else {
        format!("\"{}\"", source_name.replace('"', "\\\""))
    };
    let code_json = json_escape_string(&code);
    // Include contextId if known (captured from executionContextCreated notification
    // during Runtime.enable). This tells V8 exactly which context to evaluate in,
    // avoiding "Cannot find default execution context" errors.
    let context_id = insp.channel.context_id.get();
    let context_id_field = if context_id >= 0 {
        format!(",\"contextId\":{}", context_id)
    } else {
        String::new()
    };
    let msg = format!(
        r#"{{"id":{},"method":"Runtime.evaluate","params":{{"expression":{},"replMode":{},"awaitPromise":{},"returnByValue":false,"url":{}{}}}}}"#,
        call_id, code_json, repl_mode, await_promise, source_name_json, context_id_field
    );

    if let Some(session) = insp.session.as_mut() {
        session.dispatch_protocol_message(StringView::from(msg.as_bytes()));
    }

    // Drain any synchronous responses (sync expressions resolve immediately).
    drain_messages(scope, insp);

    rv.set(promise.into());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn json_escape_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
