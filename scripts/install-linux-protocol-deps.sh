#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 PREFIX" >&2
  exit 2
fi

case $1 in
  /*) prefix=$1 ;;
  *) prefix="$(pwd)/$1" ;;
esac
bundle=openssl-3.6.2_nghttp2-1.69.0_nghttp3-1.15.0_ngtcp2-1.22.1
marker="$prefix/.fino-protocol-deps-$bundle"
if [ -f "$marker" ]; then
  exit 0
fi

jobs=${FINO_NATIVE_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN)}
work=$(mktemp -d "${TMPDIR:-/tmp}/fino-protocol-deps.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM

download() {
  url=$1
  checksum=$2
  archive="$work/${url##*/}"
  if [ -n "${FINO_NATIVE_ARCHIVE_DIR:-}" ] &&
    [ -f "$FINO_NATIVE_ARCHIVE_DIR/${url##*/}" ]; then
    cp "$FINO_NATIVE_ARCHIVE_DIR/${url##*/}" "$archive"
  else
    curl --fail --location --retry 3 --silent --show-error "$url" --output "$archive"
  fi
  echo "$checksum  $archive" | sha256sum --check -
}

download \
  "https://github.com/openssl/openssl/releases/download/openssl-3.6.2/openssl-3.6.2.tar.gz" \
  "aaf51a1fe064384f811daeaeb4ec4dce7340ec8bd893027eee676af31e83a04f"
download \
  "https://github.com/nghttp2/nghttp2/releases/download/v1.69.0/nghttp2-1.69.0.tar.xz" \
  "1fb324b6ec2c56f6bde0658f4139ffd8209fa9e77ce98fd7a5f63af8d0e508ad"
download \
  "https://github.com/ngtcp2/nghttp3/releases/download/v1.15.0/nghttp3-1.15.0.tar.xz" \
  "6da0cd06b428d32a54c58137838505d9dc0371a900bb8070a46b29e1ceaf2e0f"
download \
  "https://github.com/ngtcp2/ngtcp2/releases/download/v1.22.1/ngtcp2-1.22.1.tar.xz" \
  "dfd2c68bd64b89847c611425b9487105c46e8447b5c21e6aeb00642c8fbe2ca8"

for archive in "$work"/*.tar.*; do
  python3 -m tarfile -e "$archive" "$work"
done

mkdir -p "$prefix"

(
  cd "$work/openssl-3.6.2"
  ./Configure --prefix="$prefix" --libdir=lib shared
  make -s -j"$jobs"
  make -s install_sw
)

(
  cd "$work/nghttp2-1.69.0"
  ./configure \
    --prefix="$prefix" \
    --enable-lib-only \
    --disable-static \
    --enable-shared
  make -s -j"$jobs"
  make -s install
)

(
  cd "$work/nghttp3-1.15.0"
  ./configure \
    --prefix="$prefix" \
    --enable-lib-only \
    --disable-static \
    --enable-shared
  make -s -j"$jobs"
  make -s install
)

(
  cd "$work/ngtcp2-1.22.1"
  PKG_CONFIG_PATH="$prefix/lib/pkgconfig" \
    LDFLAGS="-Wl,-rpath,$prefix/lib" \
    ./configure \
      --prefix="$prefix" \
      --enable-lib-only \
      --disable-static \
      --enable-shared \
      --with-openssl
  make -s -j"$jobs"
  make -s install
)

touch "$marker"
