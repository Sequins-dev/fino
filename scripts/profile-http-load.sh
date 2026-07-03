#!/usr/bin/env bash
set -euo pipefail

# HTTP/2 + HTTP/3 load/profile harness (generalized from the old
# profile-h3-app-router.sh). Starts a fino app server with TLS (and QUIC when
# PROTO=h3), warms it up, then runs a measured h2load/h3load pass. Optionally
# captures a JS pprof (fino:profiler) and/or a native pprof (pprofessor)
# scoped to the measured window.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTO="${PROTO:-h3}"
HOST="${HOST:-127.0.0.1}"
SERVER_NAME="${SERVER_NAME:-localhost}"
REQUEST_PATH="${REQUEST_PATH:-/users/123}"
REQUESTS="${REQUESTS:-200000}"
DURATION="${DURATION:-}"            # e.g. 30 — switches to -D duration mode
WARMUP_REQUESTS="${WARMUP_REQUESTS:-20000}"
CONNECTIONS="${CONNECTIONS:-100}"
MAX_STREAMS="${MAX_STREAMS:-10}"
OUT_DIR="${OUT_DIR:-/private/tmp}"
LABEL="${LABEL:-${PROTO}-run}"
JS_PROFILE_OUT="${JS_PROFILE_OUT:-}"        # set to a .pb path to capture JS pprof
NATIVE_PROFILE_OUT="${NATIVE_PROFILE_OUT:-}" # set to a .pb.gz path to capture native pprof
NATIVE_FREQ="${NATIVE_FREQ:-250}"
FINO="${FINO:-$ROOT/target/release/fino}"
H3LOAD="${H3LOAD:-$HOME/Code/cpp/h3load/build/h3load}"
H2LOAD="${H2LOAD:-h2load}"
PPROFESSOR="${PPROFESSOR:-$HOME/Code/rust/pprofessor/target/release/pprofessor}"
CERT="${CERT:-$ROOT/tests/net/fixtures/test.crt}"
KEY="${KEY:-$ROOT/tests/net/fixtures/test.key}"

case "$PROTO" in
  h2) PORT="${PORT:-3044}" ;;
  h3) PORT="${PORT:-3043}" ;;
  *) echo "error: PROTO must be h2 or h3" >&2; exit 1 ;;
esac

LOAD_OUT="${LOAD_OUT:-$OUT_DIR/$LABEL-load.txt}"
SERVER_SCRIPT="$OUT_DIR/$LABEL-server.ts"
SERVER_LOG="$OUT_DIR/$LABEL-server.log"

[[ -x "$FINO" ]] || { echo "error: FINO not executable: $FINO" >&2; exit 1; }
[[ -f "$CERT" && -f "$KEY" ]] || { echo "error: missing TLS fixtures" >&2; exit 1; }
if [[ "$PROTO" == "h3" && ! -x "$H3LOAD" ]]; then
  echo "error: H3LOAD not executable: $H3LOAD" >&2; exit 1
fi

js_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\'/\\\'}"
  printf "'%s'" "$value"
}

mkdir -p "$OUT_DIR"
rm -f "$LOAD_OUT" "$SERVER_LOG"
[[ -n "$JS_PROFILE_OUT" ]] && rm -f "$JS_PROFILE_OUT"
[[ -n "$NATIVE_PROFILE_OUT" ]] && rm -f "$NATIVE_PROFILE_OUT"

H3_OPT=""
[[ "$PROTO" == "h3" ]] && H3_OPT="h3: true,"

cat >"$SERVER_SCRIPT" <<EOF
import { App, schema } from 'fino:net/http/app';
import { v } from 'fino:validate';
import { DiskFileSystem } from 'fino:file';
import { startProfiling, stopProfiling } from 'fino:profiler';

const fs = new DiskFileSystem('/');
const app = new App({ name: 'Load Profile App' });
const profileTitle = $(js_quote "$LABEL");

let profiling = false;
let server: any;

app.use(async (ctx, next) => {
  const res = await next();
  res.headers.set('x-route', ctx.route);
  return res;
});

app.route('/users/:id')
  .value('params', schema.params(v.object({ id: v.string() })))
  .get()
  .handle((ctx) => Response.json({ id: ctx.params.id }));

app.get('/__ready', () => new Response('ready'));

app.post('/__profile/start', () => {
  if (!profiling) {
    startProfiling(profileTitle);
    profiling = true;
  }
  return new Response('started');
});

app.post('/__profile/stop', async (ctx) => {
  if (!profiling) return new Response('not profiling', { status: 409 });
  const bytes = stopProfiling(profileTitle);
  profiling = false;
  const out = ctx.request.headers.get('x-profile-out');
  if (out) await fs.writeFile(out, bytes);
  return new Response(String(bytes.byteLength));
});

app.post('/__shutdown', () => {
  setTimeout(() => {
    void server.close();
  }, 0);
  return new Response('shutdown');
});

server = app.listen({
  port: $PORT,
  hostname: $(js_quote "$HOST"),
  tls: {
    cert: $(js_quote "$CERT"),
    key: $(js_quote "$KEY")
  },
  $H3_OPT
});

await server.ready;
console.log('ready https://$SERVER_NAME:$PORT');
EOF

server_pid=""
profiling_started=0
native_pid=""
cleanup() {
  local status=$?
  [[ -n "$native_pid" ]] && kill -INT "$native_pid" 2>/dev/null || true
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    if [[ "$profiling_started" == "1" ]]; then
      curl -fsSk -X POST "https://$HOST:$PORT/__profile/stop" >/dev/null 2>&1 || true
    fi
    curl -fsSk -X POST "https://$HOST:$PORT/__shutdown" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

"$FINO" "$SERVER_SCRIPT" >"$SERVER_LOG" 2>&1 &
server_pid=$!

ready=0
for _ in $(seq 1 200); do
  if curl -fsSk "https://$HOST:$PORT/__ready" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "error: server exited before ready" >&2
    cat "$SERVER_LOG" >&2
    exit 1
  fi
  sleep 0.05
done
[[ "$ready" == "1" ]] || { echo "error: server not ready" >&2; cat "$SERVER_LOG" >&2; exit 1; }

url="https://$SERVER_NAME:$PORT$REQUEST_PATH"

run_load() {
  # args: extra flags...
  if [[ "$PROTO" == "h3" ]]; then
    "$H3LOAD" --h3 -c "$CONNECTIONS" -m "$MAX_STREAMS" \
      --connect-to="$HOST:$PORT" "$@" "$url"
  else
    "$H2LOAD" -c "$CONNECTIONS" -m "$MAX_STREAMS" \
      --connect-to="$HOST:$PORT" "$@" "$url"
  fi
}

if [[ "$WARMUP_REQUESTS" != "0" ]]; then
  echo "warmup: $WARMUP_REQUESTS requests"
  run_load -n "$WARMUP_REQUESTS" >/dev/null
fi

if [[ -n "$JS_PROFILE_OUT" ]]; then
  echo "js profile: start"
  curl -fsSk -X POST "https://$HOST:$PORT/__profile/start" >/dev/null
  profiling_started=1
fi

if [[ -n "$NATIVE_PROFILE_OUT" ]]; then
  echo "native profile: attach pid=$server_pid freq=$NATIVE_FREQ"
  "$PPROFESSOR" attach --freq "$NATIVE_FREQ" -o "$NATIVE_PROFILE_OUT" "$server_pid" &
  native_pid=$!
  sleep 0.5
fi

if [[ -n "$DURATION" ]]; then
  echo "load: duration=${DURATION}s c=$CONNECTIONS m=$MAX_STREAMS"
  run_load -D "$DURATION" | tee "$LOAD_OUT"
else
  echo "load: n=$REQUESTS c=$CONNECTIONS m=$MAX_STREAMS"
  run_load -n "$REQUESTS" | tee "$LOAD_OUT"
fi

if [[ -n "$native_pid" ]]; then
  kill -INT "$native_pid" 2>/dev/null || true
  wait "$native_pid" 2>/dev/null || true
  native_pid=""
  echo "native profile: $NATIVE_PROFILE_OUT"
fi

if [[ "$profiling_started" == "1" ]]; then
  echo "js profile: stop"
  curl -fsSk -X POST -H "x-profile-out: $JS_PROFILE_OUT" \
    "https://$HOST:$PORT/__profile/stop" >/dev/null
  profiling_started=0
  echo "js profile: $JS_PROFILE_OUT"
fi

curl -fsSk -X POST "https://$HOST:$PORT/__shutdown" >/dev/null || true
wait "$server_pid" || true
server_pid=""

echo "load out: $LOAD_OUT"
echo "server log: $SERVER_LOG"
