#!/bin/bash
#
# Run the fino test suite on Linux under the Apple `container` runtime, with the
# strict sandbox's kernel mechanisms actually enabled:
#   - Landlock, via the rebuilt kernel from build-kernel.sh (per-run --kernel
#     override; your default container kernel is untouched)
#   - cgroup v2 delegation, via cgroup-setup.sh
#
# Usage:
#   scripts/linux-sandbox/run-tests.sh                 # sandbox suites (default)
#   scripts/linux-sandbox/run-tests.sh tests/foo.test.ts ...
#
# Builds fino inside the container (Linux target cached under
# ~/.cache/fino/linux-target) and runs the given test globs.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO/scripts/linux-sandbox"
IMAGE="${CONTAINER_IMAGE:-surge-dev-machine:bookworm}"
TARGET="$HOME/.cache/fino/linux-target"
mkdir -p "$TARGET"

if [ "$#" -gt 0 ]; then
  SUITES=("$@")
else
  SUITES=(
    tests/process/process.test.ts
    tests/process/sandbox.test.ts
    tests/process/sandbox-linux.test.ts
  )
fi

# Landlock comes from the default container kernel (installed by build-kernel.sh).
# cgroup delegation is set up per-run by cgroup-setup.sh.
exec container run --rm -m 12g \
  -v "$REPO:/workspace" \
  -v "$TARGET:/ltarget" \
  -v "$HERE:/setup" \
  -w /workspace \
  -e CARGO_TARGET_DIR=/ltarget \
  "$IMAGE" \
  bash -c "cargo build && bash /setup/cgroup-setup.sh /ltarget/debug/fino test ${SUITES[*]}"
