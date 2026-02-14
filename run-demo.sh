#!/usr/bin/env bash
set -euo pipefail


CYAN='\033[0;36m'; GREEN='\033[0;32m'; NC='\033[0m'
log() { echo -e "${CYAN}[demo]${NC} $*"; }

/dev/shm/uipc_demo_ring 2>/dev/null || true

if command -v tmux >/dev/null 2>&1; then
  log "Launching demo in tmux session 'uipc'..."
  tmux new-session  -d -s uipc -x 220 -y 50
  tmux rename-window -t uipc:0 "Bun Server"
  tmux send-keys -t uipc:0 "cd '$ROOT' && bun run demo/bun_server.ts" Enter

  sleep 1

  tmux new-window  -t uipc -n "Node Client"
  tmux send-keys -t uipc:1 "sleep 0.5 && cd '$ROOT' && node demo/node_client.mjs" Enter

  tmux new-window  -t uipc -n "Deno Client"
  tmux send-keys -t uipc:2 \
    "sleep 1 && cd '$ROOT' && deno run --allow-ffi --allow-env demo/deno_client.ts" Enter

  tmux select-window -t uipc:0
  tmux attach-session -t uipc
else
  log "tmux not found — running sequentially (server in background)."
  cd "$ROOT"

  bun run demo/bun_server.ts &
  BUN_PID=$!
  trap "kill $BUN_PID 2>/dev/null" EXIT

  sleep 0.5
  node demo/node_client.mjs

  sleep 0.2
  deno run --allow-ffi --allow-env demo/deno_client.ts

  log "Demo complete. Press Ctrl-C to stop the Bun server."
  wait $BUN_PID
fi
