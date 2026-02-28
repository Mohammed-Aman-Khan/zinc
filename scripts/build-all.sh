#!/usr/bin/env bash
# scripts/build-all.sh — Build everything: Zig core + Rust N-API addon
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}[build]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC}    $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}  $*"; }
die()  { echo -e "${RED}[fail]${NC}  $*"; exit 1; }

# ── Zig core ────────────────────────────────────────────────────────────────
log "Building Zig core (ring buffer)..."

command -v zig >/dev/null 2>&1 || die "zig not found. Install from https://ziglang.org/download/"

cd "$ROOT/core"
zig build -Doptimize=ReleaseFast 2>&1 || die "Zig build failed"
ok "Zig core built → core/zig-out/lib/libuipc_core.{so,a}"

# ── Rust N-API addon (Node.js) ───────────────────────────────────────────────
log "Building Rust N-API addon (Node.js)..."

command -v cargo >/dev/null 2>&1 || { warn "cargo not found — skipping Node.js addon"; goto_deno; }
command -v node  >/dev/null 2>&1 || { warn "node not found — skipping Node.js addon";  goto_deno; }

cd "$ROOT/node-addon"
UIPC_CORE_LIB="$ROOT/core/zig-out/lib" cargo build --release 2>&1 \
  || die "Rust build failed"

# napi-rs names the output with the platform suffix; normalize it.
ADDON_SRC=$(ls "$ROOT/node-addon/target/release/"*.node 2>/dev/null | head -1 || true)
if [[ -z "$ADDON_SRC" ]]; then
  warn "No .node file found in target/release — you may need to run 'npm run build' via @napi-rs/cli"
else
  ok "Node addon built → ${ADDON_SRC}"
fi

goto_deno() { true; }  # label stub

# ── TypeScript type-check (bun) ──────────────────────────────────────────────
log "Type-checking TypeScript sources..."
command -v bun >/dev/null 2>&1 || { warn "bun not found — skipping TS check"; exit 0; }

cd "$ROOT"
bun run tsc --noEmit --strict --target ES2022 --moduleResolution bundler \
  --lib ES2022 \
  bun-ffi/index.ts deno-plugin/mod.ts protocol/flat_msg.ts protocol/rpc.ts \
  2>&1 || warn "TypeScript errors (non-fatal in development)"

ok "All builds complete."
echo ""
echo "  zig-out:    $ROOT/core/zig-out/"
echo "  node addon: $ROOT/node-addon/target/release/*.node"
echo ""
echo "  Run the demo:"
echo "    Terminal 1:  bun run examples/bun_server.ts"
echo "    Terminal 2:  node examples/node_client.mjs"
echo "    Terminal 3:  deno run --allow-ffi --allow-env examples/deno_client.ts"
