//! V8 runtime entry point.

use std::sync::OnceLock;

use ::v8;

use crate::state::ProcessEnv;

static V8_INIT: OnceLock<()> = OnceLock::new();

#[cfg(target_os = "linux")]
extern "C" fn idle_profiler_signal(_: libc::c_int) {}

/// Newtype wrapper so `SharedPtr<Allocator>` can be stored in a global.
///
/// The V8 default allocator is thread-safe (malloc/free under the hood) and
/// is designed to be shared across Isolates for SharedArrayBuffer support.
struct SharedAllocator(v8::SharedPtr<v8::Allocator>);
unsafe impl Send for SharedAllocator {}
unsafe impl Sync for SharedAllocator {}

static SHARED_ALLOCATOR: OnceLock<SharedAllocator> = OnceLock::new();

/// Return a clone of the global shared allocator.
///
/// Both the main Isolate and every thread Isolate use the same allocator so
/// that SharedArrayBuffer backing stores are accessible across Isolates.
pub(crate) fn shared_allocator() -> v8::SharedPtr<v8::Allocator> {
    SHARED_ALLOCATOR
        .get()
        .expect("shared_allocator() called before init_v8()")
        .0
        .clone()
}

pub(crate) fn init_v8() {
    V8_INIT.get_or_init(|| {
        // V8 restores the previous SIGPROF disposition when its last sampler
        // stops. A sample can still be pending on another reactor at that
        // point. Keep late samples harmless without blocking active sampling.
        // A caught handler (unlike SIG_IGN) resets on exec for external children.
        #[cfg(target_os = "linux")]
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            assert_eq!(
                libc::sigaction(libc::SIGPROF, std::ptr::null(), &mut action),
                0
            );
            if action.sa_sigaction == libc::SIG_DFL {
                action.sa_sigaction = idle_profiler_signal as *const () as usize;
                action.sa_flags = libc::SA_RESTART;
                libc::sigemptyset(&mut action.sa_mask);
                assert_eq!(
                    libc::sigaction(libc::SIGPROF, &action, std::ptr::null_mut()),
                    0
                );
            }
        }
        let mut flags = "--turbo_fast_api_calls".to_string();
        if std::env::var_os("FINO_ALLOW_NATIVES_SYNTAX").is_some() {
            flags.push_str(" --allow_natives_syntax");
        }
        v8::V8::set_flags_from_string(&flags);
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform);
        v8::V8::initialize();
    });
    // Initialize the shared allocator once V8 is up.  Multiple calls are safe.
    SHARED_ALLOCATOR.get_or_init(|| SharedAllocator(v8::new_default_allocator().into()));
}

pub fn run(process_env: ProcessEnv) -> Result<(), String> {
    crate::scheduler_native::run_command(process_env)
}
