#!/usr/bin/env bash
# scripts/run-demo.sh — Launch the cross-runtime RPC demo (legacy API)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; NC='\033[0m'
log() { echo -e "${CYAN}[demo]${NC} $*"; }

if command -v tmux >/dev/null 2>&1; then
  log "Launching cross-runtime demo in tmux session 'zinc'..."
  tmux new-session  -d -s zinc -x 220 -y 50
  tmux rename-window -t zinc:0 "Bun Server"
  tmux send-keys -t zinc:0 "cd '$ROOT' && bun run examples/bun_server.ts" Enter

  sleep 1

  tmux new-window  -t zinc -n "Node Client"
  tmux send-keys -t zinc:1 "sleep 0.5 && cd '$ROOT' && node examples/node_client.mjs" Enter

  tmux new-window  -t zinc -n "Deno Client"
  tmux send-keys -t zinc:2 \
    "sleep 1 && cd '$ROOT' && deno run --allow-ffi --allow-env examples/deno_client.ts" Enter

  tmux select-window -t zinc:0
  tmux attach-session -t zinc
else
  log "tmux not found — running sequentially (server in background)."
  cd "$ROOT"

  bun run examples/bun_server.ts &
  BUN_PID=$!
  trap "kill $BUN_PID 2>/dev/null" EXIT

  sleep 0.5
  node examples/node_client.mjs

  sleep 0.2
  deno run --allow-ffi --allow-env examples/deno_client.ts

  log "Demo complete. Press Ctrl-C to stop the Bun server."
  wait $BUN_PID
fi
