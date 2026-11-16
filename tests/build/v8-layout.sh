#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT

fail() {
  echo "$*" >&2
  exit 1
}

ninja_layout() {
  for layout in debug release; do
    fixture="$test_dir/ninja-$layout"
    build="$fixture/target/$layout/build"
    case "$layout" in
      debug) out="$build/v8-hash/out" ;;
      release) out="$build/v8/hash/out" ;;
    esac
    # Match v8 build.rs's three-parent traversal for both observed Cargo layouts.
    shared=$(dirname "$(dirname "$(dirname "$out")")")
    ninja="$shared/ninja_gn_binaries/ninja/ninja"
    gn="$shared/gn_out"
    mkdir -p "$(dirname "$ninja")" "$gn" "$fixture/crate/third_party/icu/common"
    touch "$fixture/crate/third_party/icu/common/icudtl.dat"
    printf 'is_debug = false\n' > "$gn/args.gn"
    cat > "$ninja" <<'NINJA'
#!/bin/sh
printf '%s\n' "$@"
NINJA
    chmod +x "$ninja"
    OUT_DIR="$out" CARGO_MANIFEST_DIR="$fixture/crate" \
      "$repo_root/scripts/v8-ninja-wrapper.sh" -C "$gn" rusty_v8 > "$fixture/actual"
    printf '%s\n' -C "$gn" rusty_v8 > "$fixture/expected"
    cmp "$fixture/expected" "$fixture/actual"
    if [ "$(uname -s)" = Darwin ]; then
      grep -qx 'use_lld = false' "$gn/args.gn"
    fi
  done
  echo 'ok - Ninja layouts, arguments, and Apple linker override'
}

cache_script() {
  # Execute the real composite-action shell block, substituting only its input.
  # Bash is already required by that action; the test driver itself is POSIX sh.
  awk '/^      run: \|$/ { body=1; next } body { print substr($0, 9) }' \
    "$repo_root/.github/actions/cache-cargo-deps/action.yml" |
    sed 's/${{ inputs.profile }}/'"$1"'/g' > "$test_dir/cache-action.sh"
}

cache_handoff() {
  for pair in debug:debug debug:release release:debug release/build:debug debug/build:release; do
    source_profile=${pair%:*}
    destination=${pair#*:}
    fixture="$test_dir/cache-$source_profile-$destination"
    cached="$fixture/target/$source_profile/gn_out"
    mkdir -p "$cached/obj"
    printf 'archive fixture' > "$cached/obj/librusty_v8.a"
    printf '// binding fixture\n' > "$cached/src_binding.rs"
    cache_script "$destination"
    GITHUB_WORKSPACE="$fixture" GITHUB_ENV="$fixture/env" bash -eu "$test_dir/cache-action.sh"
    test -f "$fixture/env" || fail 'restored archive was not recognized'
    grep -Fqx "RUSTY_V8_ARCHIVE=$cached/obj/librusty_v8.a" "$fixture/env" ||
      fail 'cache handoff did not select the restored archive'
    grep -Fqx "RUSTY_V8_SRC_BINDING_PATH=$cached/src_binding.rs" "$fixture/env" ||
      fail 'cache handoff did not select the paired binding'
    grep -qx 'V8_FROM_SOURCE=0' "$fixture/env"
    if grep -q 'RUSTY_V8_SKIP_DOWNLOAD' "$fixture/env"; then
      fail 'cache handoff must let rusty_v8 populate its link directory'
    fi
  done
  echo 'ok - cached archive and binding handoff across layouts and profiles'
}

incomplete_cache() {
  fixture="$test_dir/incomplete"
  mkdir -p "$fixture/target/debug/build/gn_out/obj"
  printf 'incomplete cache' > "$fixture/target/debug/build/gn_out/obj/librusty_v8.a"
  cache_script debug
  GITHUB_WORKSPACE="$fixture" GITHUB_ENV="$fixture/env" bash -eu "$test_dir/cache-action.sh"
  test ! -f "$fixture/env" || fail 'incomplete cache disabled source build'
  echo 'ok - incomplete cache keeps source build'
}

workflow_paths() {
  awk '/^[[:space:]]*target\// { sub(/^[[:space:]]*/, ""); print }' \
    "$repo_root/.github/actions/cache-cargo-deps/action.yml" | sort -u > "$test_dir/restored"
  test "$(wc -l < "$test_dir/restored" | tr -d ' ')" = 8 || fail 'expected eight restored paths'
  for workflow in ci benchmarks release dnssec-release; do
    # Keep each save block separate: one correct block must not mask another.
    awk -v prefix="$test_dir/$workflow" '
      /uses: actions\/cache\/save@v4/ { block++; saving=1; next }
      saving && /key:/ { saving=0 }
      saving && /^[[:space:]]*target\/.*(librusty_v8.a|src_binding.rs)$/ {
        sub(/^[[:space:]]*/, ""); print > (prefix "-" block)
      }
    ' "$repo_root/.github/workflows/$workflow.yml"
    found=false
    for saved in "$test_dir/$workflow-"*; do
      test -f "$saved" || continue
      found=true
      sort -u "$saved" > "$test_dir/sorted"
      cmp "$test_dir/restored" "$test_dir/sorted"
    done
    "$found" || fail "no V8 save blocks checked in $workflow"
  done
  echo 'ok - workflow cache save and restore layouts match'
}

# Individual groups also support checking the original broken implementation.
case "${1:-all}" in
  all) ninja_layout; cache_handoff; incomplete_cache; workflow_paths ;;
  ninja) ninja_layout ;;
  cache) cache_handoff ;;
  workflows) workflow_paths ;;
  *) fail 'expected all, ninja, cache, or workflows' ;;
esac
