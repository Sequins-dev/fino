#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3043}"
HOST="${HOST:-127.0.0.1}"
SERVER_NAME="${SERVER_NAME:-localhost}"
REQUEST_PATH="${REQUEST_PATH:-/users/123}"
REQUESTS="${REQUESTS:-400000}"
CONNECTIONS="${CONNECTIONS:-100}"
MAX_STREAMS="${MAX_STREAMS:-10}"
WARMUP_REQUESTS="${WARMUP_REQUESTS:-20000}"
PROFILE_TITLE="${PROFILE_TITLE:-h3-app-router}"
OUT_DIR="${OUT_DIR:-/private/tmp}"
PROFILE_OUT="${PROFILE_OUT:-$OUT_DIR/h3-app-router-profile.pb}"
LOAD_OUT="${LOAD_OUT:-$OUT_DIR/h3-app-router-h3load.json}"
SERVER_SCRIPT="${SERVER_SCRIPT:-$OUT_DIR/h3-app-router-profile-server.ts}"
SERVER_LOG="${SERVER_LOG:-$OUT_DIR/h3-app-router-profile-server.log}"
FINO="${FINO:-$ROOT/target/release/fino}"
H3LOAD="${H3LOAD:-$HOME/Code/cpp/h3load/build/h3load}"
CERT="${CERT:-$ROOT/tests/net/fixtures/test.crt}"
KEY="${KEY:-$ROOT/tests/net/fixtures/test.key}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--help]

Runs an HTTP/3 app-router benchmark and captures a JS pprof whose start/stop
boundaries are tied to the measured h3load invocation.

Configuration is via environment variables:
  PORT              TCP/UDP port to use. Default: $PORT
  REQUEST_PATH      H3 request path. Default: $REQUEST_PATH
  REQUESTS          Measured request count. Default: $REQUESTS
  CONNECTIONS       h3load connection count. Default: $CONNECTIONS
  MAX_STREAMS       h3load max concurrent streams. Default: $MAX_STREAMS
  WARMUP_REQUESTS   Pre-profile warmup request count. Default: $WARMUP_REQUESTS
  PROFILE_OUT       JS pprof output path. Default: $PROFILE_OUT
  LOAD_OUT          h3load JSON output path. Default: $LOAD_OUT
  FINO              Fino release binary. Default: $FINO
  H3LOAD            h3load binary. Default: $H3LOAD

Example:
  REQUESTS=400000 CONNECTIONS=100 MAX_STREAMS=10 "$0"
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ ! -x "$FINO" ]]; then
  echo "error: FINO is not executable: $FINO" >&2
  echo "hint: run cargo build --release, or set FINO=/path/to/fino" >&2
  exit 1
fi

if [[ ! -x "$H3LOAD" ]]; then
  echo "error: H3LOAD is not executable: $H3LOAD" >&2
  echo "hint: set H3LOAD=/path/to/h3load" >&2
  exit 1
fi

if [[ ! -f "$CERT" || ! -f "$KEY" ]]; then
  echo "error: missing TLS fixture cert/key" >&2
  echo "cert: $CERT" >&2
  echo "key:  $KEY" >&2
  exit 1
fi

js_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\'/\\\'}"
  printf "'%s'" "$value"
}

mkdir -p "$OUT_DIR"
rm -f "$PROFILE_OUT" "$LOAD_OUT" "$SERVER_LOG"

PROFILE_TITLE_JS="$(js_quote "$PROFILE_TITLE")"
PROFILE_OUT_JS="$(js_quote "$PROFILE_OUT")"
HOST_JS="$(js_quote "$HOST")"
CERT_JS="$(js_quote "$CERT")"
KEY_JS="$(js_quote "$KEY")"

cat >"$SERVER_SCRIPT" <<EOF
import { App, schema } from 'fino:net/http/app';
import { v } from 'fino:validate';
import { DiskFileSystem } from 'fino:file';
import { startProfiling, stopProfiling } from 'fino:profiler';

const fs = new DiskFileSystem('/');
const app = new App({ name: 'H3 Profile App' });
const profileTitle = $PROFILE_TITLE_JS;
const profileOut = $PROFILE_OUT_JS;

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

app.post('/__profile/stop', async () => {
  if (!profiling) return new Response('not profiling', { status: 409 });
  const bytes = stopProfiling(profileTitle);
  profiling = false;
  await fs.writeFile(profileOut, bytes);
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
  hostname: $HOST_JS,
  tls: {
    cert: $CERT_JS,
    key: $KEY_JS
  },
  h3: true
});

await server.ready;
console.log(\`ready https://${SERVER_NAME}:$PORT\`);
EOF

server_pid=""
profiling_started=0
cleanup() {
  local status=$?
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    if [[ "$profiling_started" == "1" ]]; then
      curl -fsSk -X POST "https://$HOST:$PORT/__profile/stop" >/dev/null 2>&1 || true
      profiling_started=0
    fi
    curl -fsSk -X POST "https://$HOST:$PORT/__shutdown" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

"$FINO" "$SERVER_SCRIPT" >"$SERVER_LOG" 2>&1 &
server_pid=$!

for _ in $(seq 1 200); do
  if curl -fsSk "https://$HOST:$PORT/__ready" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "error: server exited before becoming ready" >&2
    cat "$SERVER_LOG" >&2
    exit 1
  fi
  sleep 0.05
done

if ! curl -fsSk "https://$HOST:$PORT/__ready" >/dev/null; then
  echo "error: server did not become ready" >&2
  cat "$SERVER_LOG" >&2
  exit 1
fi

url="https://$SERVER_NAME:$PORT$REQUEST_PATH"
connect_to="$HOST:$PORT"

if [[ "$WARMUP_REQUESTS" != "0" ]]; then
  echo "warmup: $WARMUP_REQUESTS requests"
  "$H3LOAD" --h3 \
    -c "$CONNECTIONS" \
    -m "$MAX_STREAMS" \
    -n "$WARMUP_REQUESTS" \
    --connect-to="$connect_to" \
    "$url" >/dev/null
fi

echo "profile: start"
curl -fsSk -X POST "https://$HOST:$PORT/__profile/start" >/dev/null
profiling_started=1

echo "load: $REQUESTS requests, c=$CONNECTIONS, m=$MAX_STREAMS"
"$H3LOAD" --h3 \
  -c "$CONNECTIONS" \
  -m "$MAX_STREAMS" \
  -n "$REQUESTS" \
  --connect-to="$connect_to" \
  --output-file="$LOAD_OUT" \
  "$url"

echo "profile: stop"
curl -fsSk -X POST "https://$HOST:$PORT/__profile/stop" >/dev/null
profiling_started=0

curl -fsSk -X POST "https://$HOST:$PORT/__shutdown" >/dev/null || true
wait "$server_pid"
server_pid=""

echo "profile: $PROFILE_OUT"
echo "h3load:  $LOAD_OUT"
echo "server:  $SERVER_LOG"
