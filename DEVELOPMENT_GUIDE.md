# Zinc — development guide

This is an experimental project — don't expect it to be finished or stable in a traditional sense. What it _is_: a genuinely interesting exploration of how far you can push cross-runtime IPC on a single machine using shared memory, lock-free data structures, and multi-language FFI.

If you're contributing, you're presumably comfortable with at least one of: Zig, Rust, or TypeScript. All three are in play here. You don't need all three to be useful.

---

## How the code is organized

```
zinc/
├── src/             # The TypeScript API users actually call: serve() and connect()
│   ├── index.ts     # Public exports
│   ├── channel.ts   # ZincServer / ZincClient implementations
│   ├── runtime.ts   # Runtime detection (Bun/Deno/Node) + dynamic adapter import
│   ├── types.ts     # Shared types
│   └── adapters/
│       └── node.ts  # Wraps the Rust N-API addon to satisfy RingLike
│
├── core/            # The Zig ring buffer — the actual fast part
│   ├── ring_buffer.zig  # Lock-free ring, CRC32, POSIX shm, C-ABI exports
│   ├── ring_test.zig    # Zig unit tests
│   ├── bench.zig        # Standalone throughput benchmark
│   ├── build.zig        # Zig build config
│   └── uipc.h           # C header consumed by the Rust FFI layer
│
├── bun-ffi/         # Bun adapter — bun:ffi → libuipc_core
├── deno-plugin/     # Deno adapter — Deno.dlopen → libuipc_core
├── node-addon/      # Node.js adapter — Rust N-API → libuipc_core_static.a
│   └── src/
│       ├── lib.rs   # napi-rs bindings: UIPCRingHandle JS class
│       └── ffi.rs   # Raw C FFI declarations
│
├── protocol/        # Runtime-agnostic protocol layer (pure TS, no native deps)
│   ├── flat_msg.ts  # Binary serialization (9 scalar types, no schema needed)
│   ├── rpc.ts       # CALL/REPLY correlation, event dispatch
│   ├── pool.ts      # Multi-channel pool with round-robin and health checks
│   └── security.ts  # CRC validation, PID allowlist, rate limiting, replay guard
│
├── tests/           # Tests runnable without a live native ring
└── examples/        # Runnable demos; quickstart/ is the simplest entry point
```

Start reading in `src/channel.ts` — that's where `serve()` and `connect()` live, and it'll make the rest of the architecture obvious in about 5 minutes.

---

## Prerequisites

You need at minimum:

- **Zig ≥ 0.14** — [ziglang.org/download](https://ziglang.org/download/)
- **Node.js ≥ 20** or **Bun ≥ 1.1**

For the Node.js addon:

- **Rust ≥ 1.75** — [rustup.rs](https://rustup.rs/)

For running Deno examples:

- **Deno ≥ 1.40** — [deno.land](https://deno.land/)

Quick sanity check:

```bash
zig version && node --version && bun --version && deno --version && rustc --version
```

---

## Building

```bash
git clone https://github.com/your-org/zinc.git
cd zinc
npm install
bash scripts/build-all.sh
```

That script builds the Zig shared library, the Rust N-API addon, and runs a TypeScript type-check. The outputs are:

- `core/zig-out/lib/libuipc_core.{dylib,so}` — loaded by Bun and Deno via FFI
- `node-addon/target/release/uipc_node.node` — loaded by Node.js

Verify it works:

```bash
# Terminal 1
bun run examples/quickstart/server.ts

# Terminal 2
bun run examples/quickstart/client.ts
```

---

## Tests

The test suite doesn't require a real native ring — most tests mock or simulate it. That's intentional: native setup should not be a prerequisite for iterating on the protocol layer.

```bash
bun test tests/flat_msg.test.ts        # FlatMsg encode/decode (Bun)
node tests/flat_msg_node.mjs           # same, but on Node.js
node tests/integration_sim.mjs         # RPC round-trip simulation
node tests/security.test.mjs           # SecurityGuard logic
node tests/pool.test.mjs               # RingPool routing

cd core && zig build test              # Zig ring buffer unit tests
```

---

## Benchmarks

```bash
bash scripts/bench.sh

# Or just the Zig raw throughput benchmark:
cd core && zig build -Doptimize=ReleaseFast && ./zig-out/bin/uipc_bench
```

The Zig benchmark is the honest number — it's the ring buffer overhead with no JS layer. The JS-layer benchmark adds adapter and protocol overhead on top.

---

## Architecture notes

### Why three adapters instead of one?

Each runtime has a completely different FFI model. `bun:ffi` is synchronous and maps pointers directly. `Deno.dlopen` is similar but uses a different type system. Node.js has no built-in FFI, so we use a Rust N-API addon that statically links the Zig library. There's no clean abstraction that works across all three — the `RingLike` interface is the abstraction, and the adapters are intentionally thin.

### Why Zig for the core?

Zig gives us comptime-verified struct layouts, direct access to POSIX APIs, and genuinely zero-cost abstractions. The `Slot` struct is exactly 4096 bytes (verified at comptime), cache-line aligned, and the CRC table is computed at compile time. Getting that combination in C would work but feel tedious; in Zig it's the default.

### Why a fixed-size binary protocol instead of JSON?

4064 bytes per slot. JSON is verbose, needs allocation, and can't represent `u64` without losing precision. FlatMsg is a dead-simple key-value encoding with a two-pass encode (size first, then write) that fits in one allocation. It's not a replacement for Cap'n Proto or Flatbuffers — it's just the minimum viable thing that works for this use case.

### The RPC correlation model

Every CALL gets a monotonically increasing `msgId`. The server echoes that `msgId` back as `correlationId` in the REPLY. `RPCNode` keeps a `Map<bigint, Promise>` of in-flight calls and resolves them when the matching REPLY lands. Concurrent calls work fine. The only sharp edge: if you use two separate rings (one per direction), make sure both sides agree on which ring is which.

---

## Making changes

**TypeScript (src/ or protocol/):**

```bash
# after editing
bun run tsc --noEmit
node tests/integration_sim.mjs
```

**Zig (core/):**

```bash
cd core && zig build test
bash scripts/build-all.sh        # rebuild the shared lib
node tests/integration_sim.mjs   # verify end-to-end
```

**Rust (node-addon/):**

```bash
cd node-addon
UIPC_CORE_LIB=../core/zig-out/lib cargo build --release
node tests/integration_sim.mjs
```

---

## Troubleshooting

**`zig not found`** — install from ziglang.org/download. Homebrew also works on macOS.

**`cargo not found`** — only needed for Node.js support. `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

**Rust build fails with `UIPC_CORE_LIB not set`:**

```bash
cd node-addon
UIPC_CORE_LIB=../core/zig-out/lib cargo build --release
```

**Stale shm segment** (server crashed without cleanup):

```bash
ls /dev/shm | grep zinc    # Linux — delete the file
# macOS — in kernel memory, goes away on reboot or via ipcrm
```

**`bun:ffi` IDE type error** — expected. It's a virtual Bun module that doesn't exist as a real package. Your IDE can't resolve it; Bun can.

---

## Contributing

Open an issue before a large PR. Not because PRs aren't welcome, but because it's frustrating for everyone when work goes in a direction that doesn't fit.

Code style:

- **Zig**: 4-space indent, follow stdlib conventions
- **Rust**: `cargo fmt && cargo clippy --all-targets`
- **TypeScript**: `bun run tsc --noEmit` must be clean

Commit format: `[component] short description` — e.g. `[core] fix slot alignment on arm64`, `[rpc] handle concurrent stop() correctly`.

Before merging: build passes, all tests pass, type-check is clean.

---

## Questions

**Max message size?** 4064 bytes. Larger payloads need application-level chunking.

**Cross-machine?** No. POSIX shared memory is per-machine. Use something else (gRPC, NATS) for network transport.

**TypeScript + Node.js?** Yes — `node --import tsx/esm your-script.ts` works fine.

**Profiling?** `perf` on Linux, Instruments on macOS, or just look at the Zig benchmark numbers first before reaching for a profiler.
