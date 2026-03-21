# Zinc — development guide

Zinc is a cross-process shared memory primitive for JavaScript runtimes. The core idea: expose `mmap`'d shared memory as `ArrayBuffer` views, enabling true zero-copy data sharing across Bun, Node.js, and Deno.

Three languages are involved: Zig (native core), Rust (Node.js N-API addon), and TypeScript (public API + protocol layer). You don't need all three to contribute — pick whichever layer you're working on.

---

## Code structure

```
zinc/
├── src/                 # Public TypeScript API
│   ├── index.ts         # Exports: sharedBuffer(), serve(), connect()
│   ├── runtime.ts       # Runtime detection + dynamic adapter loading
│   ├── channel.ts       # serve()/connect() implementations (legacy RPC)
│   ├── types.ts         # SharedMemoryRegion, ZincServer, ZincClient, etc.
│   └── adapters/
│       └── node.ts      # Node.js adapter: wraps Rust N-API addon
│
├── core/                # Zig native core
│   ├── ring_buffer.zig  # Lock-free ring + shm primitives (uipc_shm_*)
│   ├── ring_test.zig    # Zig unit tests
│   ├── bench.zig        # Throughput benchmark
│   ├── build.zig        # Build config
│   └── uipc.h           # C header for FFI consumers
│
├── bun-ffi/             # Bun adapter — bun:ffi → libuipc_core
│   └── index.ts         # UIPCRing + SharedBuffer
├── deno-plugin/         # Deno adapter — Deno.dlopen → libuipc_core
│   └── mod.ts           # UIPCRing + SharedBuffer
├── node-addon/          # Node.js adapter — Rust N-API → libuipc_core
│   └── src/
│       ├── lib.rs       # UIPCRingHandle + SharedBufferHandle
│       └── ffi.rs       # Raw C FFI declarations
│
├── protocol/            # Runtime-agnostic protocol (pure TS)
│   ├── flat_msg.ts      # Binary serialization
│   ├── rpc.ts           # RPC correlation + event dispatch
│   ├── pool.ts          # Multi-channel pooling
│   └── security.ts      # CRC, PID allowlist, rate limiting
│
├── tests/               # Protocol-layer tests (no native deps needed)
├── examples/            # Runnable demos
└── RFC-001.md           # Project history and architectural rationale
```

Start reading in `src/runtime.ts` — that's where `openSharedBuffer()` and `openRing()` route to the correct adapter. The adapters themselves are straightforward wrappers around the Zig C-ABI functions.

---

## Prerequisites

- **Zig ≥ 0.14** — [ziglang.org/download](https://ziglang.org/download/)
- **Bun ≥ 1.1** or **Node.js ≥ 20** — for running TS and tests
- **Rust ≥ 1.75** — [rustup.rs](https://rustup.rs/) (only needed for Node.js addon)
- **Deno ≥ 1.40** — [deno.land](https://deno.land/) (only needed for Deno examples)

```bash
zig version && bun --version && rustc --version
```

---

## Building

```bash
git clone https://github.com/aspect-build/zinc.git
cd zinc
npm install
bash scripts/build-all.sh
```

Outputs:

- `core/zig-out/lib/libuipc_core.{dylib,so}` — loaded by Bun and Deno via FFI
- `node-addon/target/release/uipc_node.node` — loaded by Node.js

---

## Tests

Protocol-layer tests run without native dependencies:

```bash
bun test tests/flat_msg.test.ts        # FlatMsg encode/decode
node tests/flat_msg_node.mjs           # same on Node.js
node tests/integration_sim.mjs         # RPC round-trip simulation
node tests/security.test.mjs           # SecurityGuard logic
node tests/pool.test.mjs               # RingPool routing

cd core && zig build test              # Zig unit tests
```

---

## Benchmarks

```bash
bash scripts/bench.sh

# Or the raw Zig benchmark:
cd core && zig build -Doptimize=ReleaseFast && ./zig-out/bin/uipc_bench
```

---

## Architecture notes

### The two layers

**Shared buffer** (`sharedBuffer()`) — the primary path. `shm_open` + `mmap` in Zig, pointer wrapped as `ArrayBuffer` in each runtime's adapter. Both processes read/write the same physical pages. No serialization, no copies.

**Ring buffer** (`serve()`/`connect()`) — the legacy RPC path. Lock-free ring in shared memory with CRC32 integrity, used for small message-passing. Still useful for request/response patterns, but it's no longer the core primitive.

### Why three adapters?

Each runtime has a different FFI model:

- **Bun**: `bun:ffi` — synchronous, pointer mapping via `toArrayBuffer()`
- **Deno**: `Deno.dlopen` — similar but different type system, `UnsafePointerView.getArrayBuffer()`
- **Node.js**: no built-in FFI — Rust N-API addon with `napi_create_external_arraybuffer`

### Why Zig?

Comptime-verified struct layouts, direct POSIX access, and the CRC32 table computed at compile time. The `Slot` struct is exactly 4096 bytes (verified at comptime) and cache-line aligned.

---

## Making changes

**TypeScript (src/ or protocol/):**

```bash
bun run tsc --noEmit
node tests/integration_sim.mjs
```

**Zig (core/):**

```bash
cd core && zig build test
bash scripts/build-all.sh
```

**Rust (node-addon/):**

```bash
cd node-addon
UIPC_CORE_LIB=../core/zig-out/lib cargo build --release
```

---

## Troubleshooting

**`zig not found`** — install from ziglang.org/download or `brew install zig` on macOS.

**`UIPC_CORE_LIB not set`** — the Rust build needs to know where the Zig static lib is: `UIPC_CORE_LIB=../core/zig-out/lib cargo build --release`

**Stale shm segment** — if a process crashes without cleanup: `ls /dev/shm | grep zinc` on Linux and delete the file. On macOS, segments are in kernel memory and clear on reboot.

**`bun:ffi` IDE errors** — expected. It's a virtual module that only exists inside Bun.

---

## Contributing

Open an issue before a large PR.

- **Zig**: 4-space indent, follow stdlib conventions
- **Rust**: `cargo fmt && cargo clippy --all-targets`
- **TypeScript**: `bun run tsc --noEmit` must be clean

Commit format: `[component] short description` — e.g. `[core] add shm resize support`

---

## FAQ

**Max shared buffer size?** Limited by your OS. Typically `/dev/shm` is half of RAM on Linux.

**Max RPC message size?** 4064 bytes per ring slot. Use the shared buffer for larger payloads.

**Cross-machine?** No. POSIX shared memory is local. Use gRPC/NATS for network transport.

**Windows?** Not yet. The Zig core uses POSIX `shm_open`/`mmap`. Windows named shared memory would need a separate backend.
