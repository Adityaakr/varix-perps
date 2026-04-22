#!/usr/bin/env sh
# Quick check that a Substrate-style HTTP RPC answers (default Gear/Vara dev: 9933).
set -e
RPC_URL="${VARA_HTTP_RPC:-http://127.0.0.1:9933}"
BODY='{"jsonrpc":"2.0","id":1,"method":"system_health","params":[]}'

if ! command -v curl >/dev/null 2>&1; then
  echo "check-vara-rpc: curl is required" >&2
  exit 1
fi

if ! curl -sf -H "Content-Type: application/json" -d "$BODY" "$RPC_URL" >/dev/null; then
  echo "check-vara-rpc: no response from $RPC_URL" >&2
  echo "Start a local Gear/Vara dev node (WS is usually on 9944; HTTP RPC on 9933)." >&2
  exit 1
fi

echo "check-vara-rpc: OK ($RPC_URL)"
