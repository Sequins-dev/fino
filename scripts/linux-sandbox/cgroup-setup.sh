#!/bin/bash
#
# Delegate a cgroup v2 subtree for fino sandbox tests, then exec the given
# command.
#
# Inside the Apple `container` VM our process starts in the (namespaced) root
# cgroup, so controllers cannot be enabled there until the root is emptied of
# member processes (the cgroup v2 "no internal processes" rule). This moves the
# root's processes into an `init` leaf, enables cpu/cpuset/memory/pids for children,
# delegates a dedicated `fino-sandboxes` subtree, and points fino at it via
# FINO_SANDBOX_CGROUP_ROOT.
#
# Usage: cgroup-setup.sh <command> [args...]
set -e
CG=/sys/fs/cgroup

if [ ! -d "$CG" ] || [ "$(stat -fc %T "$CG" 2>/dev/null)" != "cgroup2fs" ]; then
  echo "cgroup-setup: cgroup v2 not mounted at $CG; running without delegation" >&2
  exec "$@"
fi

mkdir -p "$CG/init"
for p in $(cat "$CG/cgroup.procs" 2>/dev/null); do
  echo "$p" > "$CG/init/cgroup.procs" 2>/dev/null || true
done
echo $$ > "$CG/init/cgroup.procs" 2>/dev/null || true

echo "+cpu +cpuset +memory +pids" > "$CG/cgroup.subtree_control"
mkdir -p "$CG/fino-sandboxes"
echo "+cpu +cpuset +memory +pids" > "$CG/fino-sandboxes/cgroup.subtree_control"
export FINO_SANDBOX_CGROUP_ROOT="$CG/fino-sandboxes"
echo "cgroup-setup: delegated $FINO_SANDBOX_CGROUP_ROOT with [$(cat "$CG/fino-sandboxes/cgroup.subtree_control")]" >&2

exec "$@"
