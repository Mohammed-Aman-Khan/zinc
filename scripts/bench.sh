#!/usr/bin/env bash
# scripts/bench.sh — Run all benchmarks and produce a summary report
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CYAN='\033[0;36m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'

log()  { echo -e "${CYAN}[bench]${NC} $*"; }
head() { echo -e "\n${YELLOW}══ $* ══${NC}"; }

cd "$ROOT"

head "1. Zig core ring-buffer benchmark (raw throughput)"
log "Building bench binary..."
cd core
zig build -Doptimize=ReleaseFast
./zig-out/bin/uipc_bench
cd "$ROOT"

head "2. FlatMsg serialization micro-bench (Bun)"
if command -v bun >/dev/null 2>&1; then
cat > /tmp/flatmsg_bench.ts << 'EOF'
import { encode, decode, encodeAuto, decodeAuto, v } from "./protocol/flat_msg.ts";

const ITERS = 500_000;
const msg   = {
  method: v.str("add"),
  a:      v.u32(40),
  b:      v.u32(2),
  flag:   v.bool(true),
  pi:     v.f64(3.14159),
};

// Encode bench
const t0e = performance.now();
let encoded!: Uint8Array;
for (let i = 0; i < ITERS; i++) encoded = encode(msg);
const t1e = performance.now();

// Decode bench
const t0d = performance.now();
for (let i = 0; i < ITERS; i++) decode(encoded);
const t1d = performance.now();

const encMs = t1e - t0e;
const decMs = t1d - t0d;

console.log(`  Encode: ${ITERS} iterations in ${encMs.toFixed(1)}ms`);
console.log(`          ${(ITERS / (encMs / 1000) / 1e6).toFixed(2)}M msg/sec`);
console.log(`          ${(encMs * 1e6 / ITERS).toFixed(0)}ns per encode`);
console.log();
console.log(`  Decode: ${ITERS} iterations in ${decMs.toFixed(1)}ms`);
console.log(`          ${(ITERS / (decMs / 1000) / 1e6).toFixed(2)}M msg/sec`);
console.log(`          ${(decMs * 1e6 / ITERS).toFixed(0)}ns per decode`);
EOF
  bun run /tmp/flatmsg_bench.ts
else
  log "bun not found — skipping FlatMsg bench"
fi

head "3. Summary"
echo -e "${GREEN}"
echo "  Ring buffer (Zig): see output above"
echo "  FlatMsg (TS):      see output above"
echo "  Cross-runtime RPC: run scripts/run-demo.sh and observe throughput"
echo -e "${NC}"
