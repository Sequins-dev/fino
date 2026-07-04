# Linux sandbox testing (Apple `container`)

The strict child-process sandbox (`new Process(cmd, args, { sandbox: { mode: 'strict' } })`)
enforces policy with Linux kernel mechanisms — Landlock (filesystem confinement
and execute scoping), seccomp (syscalls, fork, coarse network), and cgroup v2
(cpu/memory/pids limits + `cgroup.kill` descendant cleanup). To exercise the
*enforcement* paths (not just the fail-closed rejections) on an Apple Silicon
Mac, we run the suite in a Linux VM under Apple's `container` runtime.

Two things the stock setup doesn't give us, and how these scripts supply them:

| Mechanism | Stock container | Fix |
|---|---|---|
| Landlock | `CONFIG_SECURITY_LANDLOCK` is **off** in the shipped kernel | `build-kernel.sh` rebuilds the same kernel series with it on |
| cgroup v2 delegation | our process sits in the root cgroup, so controllers can't be enabled | `cgroup-setup.sh` relocates root procs and delegates a subtree |

seccomp already works on the stock kernel.

## One-time setup

```bash
scripts/linux-sandbox/build-kernel.sh     # ~30 min
```

This extracts the stock kernel's config (so the rebuild stays VM-compatible),
enables `CONFIG_SECURITY_LANDLOCK=y`, compiles the kernel (Debian's
`linux-source-6.1` LTS — the Debian mirror is fast and reliable from inside the
sandbox, unlike kernel.org's v6.x tarballs) into an arm64 boot `Image` under
`~/.cache/fino/linux-kernel/`, and installs it as the **default** container
kernel via `container system kernel set`. Because the config is the stock
kernel plus Landlock, every existing `container run` keeps working — it just
gains Landlock. Landlock's semantics are stable across 6.1–6.18, so the kernel
version doesn't affect what the sandbox tests exercise.

Revert to the stock kernel any time with:

```bash
container system kernel set --recommended
```

## Running the tests

```bash
scripts/linux-sandbox/run-tests.sh                        # the sandbox suites
scripts/linux-sandbox/run-tests.sh tests/runtime/foo.test.ts
```

`run-tests.sh` builds fino into a cached Linux target dir and runs the tests
through `cgroup-setup.sh` so `FINO_SANDBOX_CGROUP_ROOT` points at a properly
delegated subtree. Landlock comes from the default kernel installed above.

If the Landlock kernel hasn't been installed, the run still works but
Landlock-backed policy (filesystem, `allowExec`, `allowedBinaries`) fails closed
with a clear error — the correct, safe behavior, just not an enforcement test.
