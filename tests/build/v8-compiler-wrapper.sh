#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin" "$test_dir/work" "$test_dir/resource"

cat > "$test_dir/bin/clang++" <<'EOF'
#!/bin/sh
if [ "${1:-}" = '-print-resource-dir' ]; then
  printf '%s\n' "$TEST_RESOURCE_DIR"
fi
EOF
chmod +x "$test_dir/bin/clang++"

# A concurrent ln -sfn can remove the shared link between another wrapper's
# failed ln and readlink. Force that interleaving without relying on timing.
cat > "$test_dir/bin/ln" <<'EOF'
#!/bin/sh
if [ "${1:-}" = '-sfn' ]; then
  exit 1
fi
exec /bin/ln "$@"
EOF
chmod +x "$test_dir/bin/ln"

cat > "$test_dir/bin/sccache" <<'EOF'
#!/bin/sh
exec "$@"
EOF
chmod +x "$test_dir/bin/sccache"

# The wrapper asks the LLVM behind LIBCLANG_PATH for its resource directory
# whenever that variable is set, as it is in CI. Clear it so the fake clang++
# above is the compiler being asked, rather than the runner's real one.
TEST_RESOURCE_DIR="$test_dir/resource" \
  LIBCLANG_PATH= \
  CARGO_MANIFEST_DIR="$test_dir/work" \
  PATH="$test_dir/bin:$PATH" \
  "$repo_root/scripts/v8-compiler-wrapper.sh" "$test_dir/bin/clang++" -c fixture.cc

test "$(readlink "$test_dir/work/fino-clang-resource")" = "$test_dir/resource"
