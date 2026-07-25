//! Parked V8 isolates for the TypeScript readiness scheduler.
//!
//! Native code owns only the parts TypeScript cannot express: creating an
//! isolate, entering it for one non-blocking pump, and restoring that isolate's
//! async-runtime state. Readiness registration and scheduling policy remain in
//! `js/internal/scheduler/readiness.ts`; I/O syscalls and buffers remain in the
//! workload isolate.

use std::{cell::RefCell, rc::Rc};

use ::v8;

use crate::{
    loader,
    state::{FinoState, ProcessEnv, default_import_rules, get_state},
};

struct ParkedWorkload {
    context: v8::Global<v8::Context>,
    dispatch_fn: v8::Global<v8::Function>,
    take_ops_fn: v8::Global<v8::Function>,
    complete_fn: v8::Global<v8::Function>,
    settled_fn: v8::Global<v8::Function>,
    active_promise: Option<v8::Global<v8::Promise>>,
    async_state: Option<crate::async_rt::IsolateAsyncState>,
    _state: Rc<RefCell<FinoState>>,
    _module: v8::Global<v8::Module>,
    isolate: v8::OwnedIsolate,
}

struct WorkloadTable(Vec<Option<ParkedWorkload>>);

impl Drop for WorkloadTable {
    fn drop(&mut self) {
        for workload in self.0.drain(..).flatten() {
            drop_parked(workload);
        }
    }
}

thread_local! {
    static WORKLOADS: RefCell<WorkloadTable> = const { RefCell::new(WorkloadTable(Vec::new())) };
}

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        "createWorkload",
        "dispatchWorkload",
        "completeHostOperation",
        "terminateWorkload",
        "workloadWakeFd",
    ]
    .iter()
    .map(|name| v8::String::new(scope, name).unwrap())
    .collect();
    let module_name = v8::String::new(scope, "internal:scheduler-native").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };

    macro_rules! set_fn {
        ($name:literal, $callback:path) => {{
            let template = v8::FunctionTemplate::new(scope, $callback);
            let function = template.get_function(scope)?;
            let key = v8::String::new(scope, $name)?;
            module.set_synthetic_module_export(scope, key, function.into())?;
        }};
    }

    set_fn!("createWorkload", create_workload);
    set_fn!("dispatchWorkload", dispatch_workload);
    set_fn!("completeHostOperation", complete_host_operation);
    set_fn!("terminateWorkload", terminate_workload);
    set_fn!("workloadWakeFd", workload_wake_fd);
    Some(v8::undefined(scope).into())
}

fn throw_error(scope: &mut v8::HandleScope, message: &str) {
    let message = v8::String::new(scope, message).unwrap();
    let exception = v8::Exception::error(scope, message);
    scope.throw_exception(exception);
}

fn js_string(scope: &mut v8::HandleScope, value: v8::Local<v8::Value>) -> String {
    value
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_else(|| "unknown exception".to_string())
}

fn json_quote(input: &str) -> String {
    serde_json::to_string(input).unwrap_or_else(|_| "\"\"".to_string())
}

fn global_function(
    scope: &mut v8::HandleScope,
    context: v8::Local<v8::Context>,
    name: &str,
) -> Result<v8::Global<v8::Function>, String> {
    let key =
        v8::String::new(scope, name).ok_or_else(|| format!("failed to allocate {name} key"))?;
    let value = context
        .global(scope)
        .get(scope, key.into())
        .ok_or_else(|| format!("{name} is missing"))?;
    let function = v8::Local::<v8::Function>::try_from(value)
        .map_err(|_| format!("{name} is not a function"))?;
    Ok(v8::Global::new(scope, function))
}

fn setup_workload(
    entry_path: String,
    process_env: ProcessEnv,
    package_map_json: Option<String>,
) -> Result<ParkedWorkload, String> {
    crate::runtime::init_v8();

    let params = v8::CreateParams::default()
        .array_buffer_allocator(crate::runtime::shared_allocator().clone());
    let mut isolate = v8::Isolate::new(params);
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    isolate.set_allow_atomics_wait(true);
    isolate.set_host_import_module_dynamically_callback(loader::dynamic_import_callback);
    isolate.set_host_initialize_import_meta_object_callback(loader::init_import_meta_callback);

    let saved_async_state = crate::async_rt::swap_state(Some(crate::async_rt::new_state()));
    let initialized = (|| {
        let isolate_scope = &mut v8::HandleScope::new(&mut isolate);
        let root_queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);
        let context = v8::Context::new(isolate_scope, Default::default());
        context.set_microtask_queue(&root_queue);
        let scope = &mut v8::ContextScope::new(isolate_scope, context);
        let state = FinoState::new_root(
            process_env,
            package_map_json,
            root_queue,
            default_import_rules(),
        );
        context.set_slot(Rc::new(RefCell::new(state)));
        let initial_frame = v8::Array::new(scope, 0);
        scope.set_continuation_preserved_embedder_data(initial_frame.into());
        let marker_key = v8::String::new(scope, "__finoSchedulerDelegatesReadiness")
            .ok_or_else(|| "failed to allocate scheduler marker".to_string())?;
        let marker_value = v8::Boolean::new(scope, true);
        context
            .global(scope)
            .set(scope, marker_key.into(), marker_value.into());

        let runner = format!(
            "import 'internal:bootstrap';\n\
             import {{ configureWorkload }} from 'internal:scheduler/workload';\n\
             configureWorkload(import({}));\n",
            json_quote(&entry_path)
        );

        let module = {
            let tc = &mut v8::TryCatch::new(scope);
            loader::compile_source_module(tc, &runner, "internal:scheduler-workload", None)
                .ok_or_else(|| {
                    crate::realm::child::catch_message(tc)
                        .unwrap_or_else(|| "failed to compile scheduler workload".to_string())
                })?
        };
        loader::register_as_builtin(scope, module, "internal:scheduler-workload");
        {
            let tc = &mut v8::TryCatch::new(scope);
            module
                .instantiate_module(tc, loader::resolve_module_callback)
                .ok_or_else(|| {
                    crate::realm::child::catch_message(tc)
                        .unwrap_or_else(|| "failed to instantiate scheduler workload".to_string())
                })?;
        }
        {
            let tc = &mut v8::TryCatch::new(scope);
            module.evaluate(tc).ok_or_else(|| {
                crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "failed to evaluate scheduler workload".to_string())
            })?;
        }
        crate::realm::child::pump_and_checkpoint(scope);
        if module.get_status() == v8::ModuleStatus::Errored {
            return Err(js_string(scope, module.get_exception()));
        }

        Ok((
            v8::Global::new(scope, context),
            global_function(scope, context, "__finoSchedulerDispatch")?,
            global_function(scope, context, "__finoSchedulerTakeHostOps")?,
            global_function(scope, context, "__finoSchedulerCompleteHostOp")?,
            global_function(scope, context, "__finoSchedulerSettled")?,
            get_state(scope),
            v8::Global::new(scope, module),
        ))
    })();
    let workload_async_state = crate::async_rt::swap_state(saved_async_state);
    let (context, dispatch_fn, take_ops_fn, complete_fn, settled_fn, state, module) = initialized?;

    let mut workload = ParkedWorkload {
        context,
        dispatch_fn,
        take_ops_fn,
        complete_fn,
        settled_fn,
        active_promise: None,
        async_state: workload_async_state,
        _state: state,
        _module: module,
        isolate,
    };
    unsafe {
        workload.isolate.exit();
    }
    Ok(workload)
}

fn create_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let entry_path = args
        .get(0)
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_default();
    if entry_path.is_empty() {
        throw_error(scope, "createWorkload: entry path is required");
        return;
    }
    let parent_state = get_state(scope);
    let (process_env, package_map_json) = {
        let state = parent_state.borrow();
        (state.process_env.clone(), state.package_map_json.clone())
    };
    let workload = match setup_workload(entry_path, process_env, package_map_json) {
        Ok(workload) => workload,
        Err(error) => {
            throw_error(scope, &format!("createWorkload: {error}"));
            return;
        }
    };
    let handle = WORKLOADS.with(|table| {
        let mut table = table.borrow_mut();
        if let Some(index) = table.0.iter().position(Option::is_none) {
            table.0[index] = Some(workload);
            index
        } else {
            let index = table.0.len();
            table.0.push(Some(workload));
            index
        }
    });
    rv.set(v8::Integer::new(scope, handle as i32).into());
}

fn call_string_function(
    scope: &mut v8::HandleScope,
    function: &v8::Global<v8::Function>,
    args: &[v8::Local<v8::Value>],
) -> Result<String, String> {
    let function = v8::Local::new(scope, function);
    let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
    let tc = &mut v8::TryCatch::new(scope);
    let value = function.call(tc, receiver, args).ok_or_else(|| {
        crate::realm::child::catch_message(tc)
            .unwrap_or_else(|| "scheduler helper threw".to_string())
    })?;
    value
        .to_string(tc)
        .map(|value| value.to_rust_string_lossy(tc))
        .ok_or_else(|| "scheduler helper did not return a string".to_string())
}

fn take_host_operations(
    scope: &mut v8::HandleScope,
    context: v8::Local<v8::Context>,
    take_ops_fn: &v8::Global<v8::Function>,
) -> Result<Option<String>, String> {
    let key = v8::String::new(scope, "__finoSchedulerHostOps")
        .ok_or_else(|| "failed to allocate host operation key".to_string())?;
    let value = context
        .global(scope)
        .get(scope, key.into())
        .ok_or_else(|| "host operation queue is missing".to_string())?;
    let operations = v8::Local::<v8::Array>::try_from(value)
        .map_err(|_| "host operation queue is not an array".to_string())?;
    if operations.length() == 0 {
        return Ok(None);
    }
    let json = call_string_function(scope, take_ops_fn, &[])?;
    Ok(Some(format!(
        "{{\"kind\":\"hostOperations\",\"operations\":{json}}}"
    )))
}

fn dispatch_entered(workload: &mut ParkedWorkload, request_json: &str) -> Result<String, String> {
    let context_global = workload.context.clone();
    let dispatch_fn = workload.dispatch_fn.clone();
    let take_ops_fn = workload.take_ops_fn.clone();
    let settled_fn = workload.settled_fn.clone();
    let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
    let context = v8::Local::new(isolate_scope, &context_global);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);

    if workload.active_promise.is_none() {
        let function = v8::Local::new(scope, &dispatch_fn);
        let request = v8::String::new(scope, request_json)
            .ok_or_else(|| "failed to allocate workload request".to_string())?;
        let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
        let promise = {
            let tc = &mut v8::TryCatch::new(scope);
            let value = function
                .call(tc, receiver, &[request.into()])
                .ok_or_else(|| {
                    crate::realm::child::catch_message(tc)
                        .unwrap_or_else(|| "scheduler workload dispatch threw".to_string())
                })?;
            let promise = v8::Local::<v8::Promise>::try_from(value)
                .map_err(|_| "scheduler workload dispatch did not return a promise".to_string())?;
            v8::Global::new(tc, promise)
        };
        workload.active_promise = Some(promise);
    }

    crate::realm::child::pump_and_checkpoint(scope);
    if let Some(operations) = take_host_operations(scope, context, &take_ops_fn)? {
        return Ok(operations);
    }

    let promise = v8::Local::new(scope, workload.active_promise.as_ref().unwrap());
    match promise.state() {
        v8::PromiseState::Pending => Ok("{\"kind\":\"pending\"}".to_string()),
        v8::PromiseState::Fulfilled => {
            let value = promise.result(scope);
            workload.active_promise = None;
            call_string_function(scope, &settled_fn, &[value])
        }
        v8::PromiseState::Rejected => {
            let value = promise.result(scope);
            workload.active_promise = None;
            Err(js_string(scope, value))
        }
    }
}

fn with_entered_workload<T>(
    workload: &mut ParkedWorkload,
    callback: impl FnOnce(&mut ParkedWorkload) -> Result<T, String>,
) -> Result<T, String> {
    let saved_async_state = crate::async_rt::swap_state(workload.async_state.take());
    unsafe {
        workload.isolate.enter();
    }
    let result = callback(workload);
    unsafe {
        workload.isolate.exit();
    }
    workload.async_state = crate::async_rt::swap_state(saved_async_state);
    result
}

fn dispatch_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let request_json = args
        .get(1)
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_else(|| "{}".to_string());
    let result = WORKLOADS.with(|table| {
        let mut table = table.borrow_mut();
        let workload = table
            .0
            .get_mut(handle)
            .and_then(Option::as_mut)
            .ok_or_else(|| "dispatchWorkload: invalid workload handle".to_string())?;
        with_entered_workload(workload, |workload| {
            dispatch_entered(workload, &request_json)
        })
    });
    match result {
        Ok(json) => {
            if let Some(value) = v8::String::new(scope, &json) {
                rv.set(value.into());
            }
        }
        Err(error) => throw_error(scope, &error),
    }
}

fn complete_entered(
    workload: &mut ParkedWorkload,
    operation_id: i64,
    ok: bool,
    result_json: &str,
) -> Result<(), String> {
    let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
    let context = v8::Local::new(isolate_scope, &workload.context);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);
    let function = v8::Local::new(scope, &workload.complete_fn);
    let id = v8::Number::new(scope, operation_id as f64);
    let ok = v8::Boolean::new(scope, ok);
    let json = v8::String::new(scope, result_json)
        .ok_or_else(|| "failed to allocate host operation result".to_string())?;
    let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
    {
        let tc = &mut v8::TryCatch::new(scope);
        function
            .call(tc, receiver, &[id.into(), ok.into(), json.into()])
            .ok_or_else(|| {
                crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "host operation completion threw".to_string())
            })?;
    }
    crate::realm::child::pump_and_checkpoint(scope);
    Ok(())
}

fn complete_host_operation(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let operation_id = args.get(1).integer_value(scope).unwrap_or(-1);
    let ok = args.get(2).boolean_value(scope);
    let result_json = args
        .get(3)
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_else(|| "null".to_string());
    let result = WORKLOADS.with(|table| {
        let mut table = table.borrow_mut();
        let workload = table
            .0
            .get_mut(handle)
            .and_then(Option::as_mut)
            .ok_or_else(|| "completeHostOperation: invalid workload handle".to_string())?;
        with_entered_workload(workload, |workload| {
            complete_entered(workload, operation_id, ok, &result_json)
        })
    });
    if let Err(error) = result {
        throw_error(scope, &error);
    }
}

fn drop_parked(mut workload: ParkedWorkload) {
    unsafe {
        workload.isolate.enter();
    }
    drop(workload);
}

fn terminate_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    WORKLOADS.with(|table| {
        let mut table = table.borrow_mut();
        if let Some(workload) = table.0.get_mut(handle).and_then(Option::take) {
            drop_parked(workload);
        }
    });
}

fn workload_wake_fd(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let fd = WORKLOADS.with(|table| {
        table
            .borrow()
            .0
            .get(handle)
            .and_then(Option::as_ref)
            .and_then(|workload| workload.async_state.as_ref())
            .map(|state| state.wake_read)
            .unwrap_or(-1)
    });
    rv.set(v8::Integer::new(scope, fd).into());
}
