#!/bin/sh
set -eu

# Make the downloaded Chromium Clang's builtin headers discoverable by
# rusty_v8's subsequent bindgen step. The compiler wrapper receives clang as
# its first argument and runs before bindgen.
compiler="${1:-}"
case "$compiler" in
  *clang | *clang++ )
    # Bindgen parses with libclang, which may come from a different LLVM
    # installation than Chromium's compiler. Its resource headers must match
    # that libclang: mixing Chromium Clang 23 headers with Homebrew libclang 22
    # leaves libc++'s fixed-width integer using-declarations unresolved.
    bindgen_clang="$compiler"
    if [ -n "${LIBCLANG_PATH:-}" ]; then
      libclang_clang="$(dirname "$LIBCLANG_PATH")/bin/clang"
      if [ -x "$libclang_clang" ]; then
        bindgen_clang="$libclang_clang"
      fi
    fi
    resource_dir="$($bindgen_clang -print-resource-dir)"
    resource_link="${CARGO_MANIFEST_DIR}/fino-clang-resource"
    # Ninja starts many compiler wrappers concurrently. macOS ln can report
    # EEXIST when another wrapper creates this link between its lookup and
    # replacement; accept that race only when the winner installed our target.
    if ! ln -sfn "$resource_dir" "$resource_link" 2>/dev/null; then
      [ "$(readlink "$resource_link" 2>/dev/null || true)" = \
        "$resource_dir" ] || exit 1
    fi
    ;;
esac

if command -v sccache >/dev/null 2>&1; then
  sccache "$@"
else
  "$@"
fi

# Keep rusty_v8's entire C ABI except its isolate-allocation entry point. Fino's
# C++ shim supplies that symbol and delegates all post-allocation ownership to
# the unchanged Rust Isolate::new path.
binding_source="${CARGO_MANIFEST_DIR:-}/src/binding.cc"
compiled_source=""
output_file=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "-o" ]; then
    output_file="$argument"
  fi
  case "$argument" in
    */src/binding.cc | src/binding.cc )
      resolved_source="$(python3 -c \
        'import os, sys; print(os.path.realpath(sys.argv[1]))' \
        "$argument")"
      if [ "$resolved_source" = "$binding_source" ]; then
        compiled_source="$argument"
      fi
      ;;
  esac
  previous="$argument"
done

if [ -n "$compiled_source" ] && [ -n "$output_file" ]; then
  compiler_dir="$(dirname "$compiler")"
  objcopy="$compiler_dir/llvm-objcopy"
  if [ ! -x "$objcopy" ]; then
    objcopy="$(command -v llvm-objcopy)"
  fi
  "$objcopy" \
    --redefine-sym \
    v8__Isolate__New=fino__rusty_v8__Isolate__New \
    "$output_file"
fi
