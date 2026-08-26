#!/bin/sh
set -eu

# The crates.io package excludes ICU's generated data blob to stay within its
# size limit, but Intl-enabled V8 source builds embed it in the static library.
# Restore the exact blob from the ICU revision pinned by v8 152.2.0 before
# Ninja resolves its input graph.
icu_data="${CARGO_MANIFEST_DIR:-}/third_party/icu/common/icudtl.dat"
if [ ! -f "$icu_data" ]; then
  python3 - "$icu_data" <<'PY'
import base64
import hashlib
import os
import sys
import urllib.request

path = sys.argv[1]
revision = "d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738"
expected = "9f48c7f9c7c94d516a14870707e910ab94d75ae640ff6842c4af53276cd26ebe"
url = (
    "https://chromium.googlesource.com/chromium/deps/icu.git/+/"
    f"{revision}/common/icudtl.dat?format=TEXT"
)

with urllib.request.urlopen(url) as response:
    data = base64.b64decode(response.read())
actual = hashlib.sha256(data).hexdigest()
if actual != expected:
    raise SystemExit(f"unexpected ICU data checksum: {actual}")

os.makedirs(os.path.dirname(path), exist_ok=True)
temporary = f"{path}.fino-{os.getpid()}"
with open(temporary, "wb") as output:
    output.write(data)
os.replace(temporary, path)
PY
fi

profile_dir="${OUT_DIR%%/build/*}"
real_ninja="$profile_dir/ninja_gn_binaries/ninja/ninja"
if [ ! -x "$real_ninja" ]; then
  echo "could not locate rusty_v8's Ninja binary at $real_ninja" >&2
  exit 1
fi
exec "$real_ninja" "$@"
