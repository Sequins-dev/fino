#!/bin/bash
#
# Build a Linux kernel for Apple `container` with the Landlock LSM enabled.
#
# The stock container kernel ships with `CONFIG_SECURITY_LANDLOCK` off, so the
# strict sandbox's filesystem confinement and execute scoping can only fail
# closed there. This rebuilds a kernel with Landlock turned on, reusing the stock
# kernel's exact config (extracted from /proc/config.gz) so all the virtio/vsock/
# console drivers the Apple VM needs are preserved.
#
# Source is Debian's `linux-source-6.1` — the Debian mirror is fast and reliable
# from inside the sandbox (kernel.org's v6.x tarballs 404 here and the GitHub
# archive stream is throttled). 6.1 is an LTS with stable Landlock; only the
# config (not the version) matters for testing fino's sandbox, and 6.1's virtio
# drivers boot the same Apple VM.
#
# Output: ~/.cache/fino/linux-kernel/Image-landlock (an arm64 boot Image),
# installed as the default container kernel. Re-run to rebuild from scratch.
set -euo pipefail

IMAGE="${CONTAINER_IMAGE:-surge-dev-machine:bookworm}"
OUT="$HOME/.cache/fino/linux-kernel"
mkdir -p "$OUT"

# 1. Extract the stock kernel's config so the rebuild stays VM-compatible.
if [ ! -f "$OUT/config-base" ]; then
  echo "==> extracting stock kernel config from a throwaway container"
  container run --rm -v "$OUT:/out" "$IMAGE" \
    bash -c 'zcat /proc/config.gz > /out/config-base'
fi

# 2. Build the kernel inside a Linux container (native arm64).
cat > "$OUT/_build-inner.sh" <<'INNER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  build-essential bc bison flex libssl-dev libelf-dev cpio kmod xz-utils linux-source-6.1 >/dev/null
# Extract and build on the container's own filesystem: the macOS-mounted /out
# cannot represent some of the kernel source's symlinks. Only the Image (16 MB)
# is copied back out.
mkdir -p /build && cd /build
tar xf /usr/src/linux-source-6.1.tar.xz
cd linux-source-6.1
cp /out/config-base .config
scripts/config --enable CONFIG_SECURITY_LANDLOCK
make ARCH=arm64 olddefconfig >/dev/null
grep -q 'CONFIG_SECURITY_LANDLOCK=y' .config || { echo "Landlock not enabled in .config"; exit 1; }
make ARCH=arm64 -j"$(nproc)" Image 2>&1 | tail -3
cp arch/arm64/boot/Image /out/Image-landlock
INNER

echo "==> building linux-source-6.1 with Landlock (this takes a while)"
container run --rm -m 12g -v "$OUT:/out" "$IMAGE" bash /out/_build-inner.sh

echo "==> built: $OUT/Image-landlock"
ls -la "$OUT/Image-landlock"

# 3. Install it as the default container kernel. The config is the stock kernel
#    plus Landlock, so existing workflows keep working; revert any time with
#    `container system kernel set --recommended`.
echo "==> setting it as the default container kernel"
container system kernel set --binary "$OUT/Image-landlock" --arch arm64 --force
echo "==> done. Landlock is now available in every 'container run'."
