# Child Process Containment — Remaining Work

> Status: the strict process sandbox is implemented. This note tracks the
> policy capabilities that remain beyond the shipped coarse containment
> boundary.

## Current Baseline

`new Process(command, args, { sandbox })` supports strict and best-effort
policy with an enforcement report derived from the mechanisms actually
installed.

The strict path re-executes Fino as a self-sandboxing launcher, applies policy
before target code runs, and then `execve`s the requested command without
changing its pid or stdio contract. The implementation is TypeScript over thin
FFI bindings in `internal:security/sandbox/*`.

The shipped backends are:

- Linux: rlimits or delegated cgroup v2 resources, Landlock filesystem and
  execute policy, seccomp syscall/fork policy, coarse network isolation, and
  cgroup or process-group descendant cleanup.
- macOS: generated Seatbelt profiles, rlimits, coarse/directional network
  policy where expressible, execute scoping, and process-group cleanup.

Strict mode fails before spawn when the host cannot enforce a requested
category. Fine-grained network rules carrying a destination, port, or protocol
are deliberately rejected rather than silently weakened. The maintained public
contract and examples live in `fino:process`; platform enforcement is covered
by the process sandbox test suites.

## Filtered Egress

The remaining enforcement gap is destination-aware outbound networking:

- allow or deny IP addresses and CIDRs;
- constrain destination ports and transport protocols;
- preserve DNS and connection behavior without granting the host network
  wholesale;
- report the exact installed filter and fail closed when it cannot be applied.

An empty network namespace implements "no network," but it cannot express
selective egress. The in-process direction is a network namespace with a TUN
device whose traffic is handled and filtered by Fino's own async network stack.
This needs a spike before the public rule semantics are committed: prove packet
flow, DNS behavior, cancellation, bounded queues, and cleanup without a helper
daemon.

Until that spike succeeds, strict mode must continue rejecting every rule with
destination, port, or protocol detail before spawning the child.

## Hostname And SNI Policy

Hostname rules such as `*.example.com` require a contract beyond packet-level
filtering. DNS answers can change and TLS SNI does not cover every protocol.
Keep hostname/SNI matching out of the core filtered-egress milestone. If demand
justifies it, specify resolution pinning, rebinding behavior, encrypted DNS,
non-TLS traffic, and fail-closed handling separately before choosing an eBPF or
userspace inspection mechanism.

## Policy Composition And Presets

Two higher-level conveniences remain useful after filtered egress:

- Presets expand in TypeScript into the ordinary policy object, for example a
  read-only POSIX tool or a no-network command profile. Reports continue to
  describe mechanisms rather than preset names.
- Tighten-only composition lets an operator ceiling be narrowed but never
  widened by a caller: deny-only network additions, syscall-deny union,
  fork/exec that cannot be re-enabled, `allowedBinaries` intersection,
  resource minimums, and filesystem subsets.

Composition must be a pure, directly tested policy transformation performed
before backend selection. It must not introduce a second enforcement path.

## Delivery Order

1. Prove selective IP/CIDR and port filtering through the TUN/userspace-stack
   spike, including bounded backpressure and teardown.
2. Commit and implement the filtered-egress rule semantics only if the spike
   satisfies strict fail-closed behavior on the supported Linux hosts.
3. Add presets as policy expansion helpers.
4. Add tighten-only policy composition for scheduler and multi-tenant callers.
5. Consider hostname/SNI policy independently and only with a complete trust
   and DNS-rebinding model.

## Required Tests

- allowed and denied IP/CIDR connections behave as specified;
- port and protocol mismatches fail without fallback to host networking;
- DNS resolution cannot escape the installed policy;
- slow or hostile traffic keeps packet queues bounded;
- cancellation and child exit release the TUN device and filtering state;
- unsupported filtered rules fail before spawn;
- preset expansion equals its explicit policy;
- every tighten-only merge dimension rejects attempted widening.
