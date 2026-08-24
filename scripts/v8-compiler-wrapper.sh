#!/bin/sh
set -eu

# Make the downloaded Chromium Clang's builtin headers discoverable by
# rusty_v8's subsequent bindgen step. The compiler wrapper receives clang as
# its first argument and runs before bindgen.
compiler="${1:-}"
case "$compiler" in
  *clang | *clang++ )
    resource_dir="$($compiler -print-resource-dir)"
    ln -sfn "$resource_dir/include" \
      "${CARGO_MANIFEST_DIR}/fino-clang-include"
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
