#!/usr/bin/env bash
# Builds all native components: Zig core + Rust N-API addon.
# Set ZINC_LIB_DIR after the build to override the default lib search path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
log()  { echo -e "${CYAN}[zinc/build]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC}         $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}       $*"; }
die()  { echo -e "${RED}[fail]${NC}       $*"; exit 1; }

echo ""
echo -e "${BOLD} Zinc — Building native components${NC}"
echo "   $(uname -s) $(uname -m)"
echo ""

# ── 1. Zig core (ring buffer shared library) ─────────────────────────────────
log "Building Zig core (lock-free ring buffer)..."

command -v zig >/dev/null 2>&1 || die "zig not found. Install from https://ziglang.org/download/"

cd "$ROOT/core"
zig build -Doptimize=ReleaseFast 2>&1 || die "Zig build failed"
ok "Zig core → core/zig-out/lib/libuipc_core.{dylib,so,a}"

# ── 2. Rust N-API addon (Node.js) ────────────────────────────────────────────
log "Building Rust N-API addon (Node.js support)..."

if ! command -v cargo >/dev/null 2>&1; then
  warn "cargo not found — skipping Node.js addon (Bun and Deno will still work)"
elif ! command -v node >/dev/null 2>&1; then
  warn "node not found — skipping Node.js addon"
else
  cd "$ROOT/node-addon"
  UIPC_CORE_LIB="$ROOT/core/zig-out/lib" cargo build --release 2>&1 \
    || die "Rust build failed"

  ADDON_SRC=$(ls "$ROOT/node-addon/target/release/"*.node 2>/dev/null | head -1 || true)
  if [[ -z "$ADDON_SRC" ]]; then
    warn "No .node file found — you may need to run 'npm run build' via @napi-rs/cli"
  else
    ok "Node.js addon → ${ADDON_SRC}"
  fi
fi

# ── 3. TypeScript type-check ──────────────────────────────────────────────────
cd "$ROOT"
if command -v bun >/dev/null 2>&1; then
  log "Type-checking TypeScript sources..."
  bun run tsc --noEmit 2>&1 || warn "TypeScript errors (non-fatal in development)"
  ok "TypeScript checked"
else
  warn "bun not found — skipping TypeScript check"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD} Build complete!${NC}"
echo ""
echo "  Native library: $ROOT/core/zig-out/lib/"
echo "  Node.js addon:  $ROOT/node-addon/target/release/*.node"
echo ""
echo "  Quickstart:"
echo "    Terminal 1:  bun run examples/quickstart/server.ts"
echo "    Terminal 2:  bun run examples/quickstart/client.ts"
echo "               (or swap 'bun' for 'deno run --allow-ffi --allow-env',"
echo "                or 'node --import tsx/esm' for Node.js)"
echo ""
echo "  Demo (cross-runtime):"
echo "    Terminal 1:  bun run examples/bun_server.ts"
echo "    Terminal 2:  deno run --allow-ffi --allow-env examples/deno_client.ts"
echo "    Terminal 3:  node examples/node_client.mjs"
echo ""
echo "  Override lib path: export ZINC_LIB_DIR=/path/to/lib"
echo ""
