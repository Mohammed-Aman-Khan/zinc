# ⚡ Zinc — Development Guide

Welcome! This guide covers the project structure, build process, architecture internals, and contribution workflow for **Zinc** — the Universal IPC Bridge for JS Runtimes.

## Table of Contents

1. [Project Overview](#project-overview)
2. [Prerequisites](#prerequisites)
3. [Project Structure](#project-structure)
4. [Getting Started](#getting-started)
5. [Running Tests](#running-tests)
6. [Running Benchmarks](#running-benchmarks)
7. [Running the Demo](#running-the-demo)
8. [Development Workflow](#development-workflow)
9. [Architecture Deep Dive](#architecture-deep-dive)
10. [Common Tasks](#common-tasks)
11. [Troubleshooting](#troubleshooting)
12. [Contributing](#contributing)

---

## Project Overview

**Zinc** is a high-performance, zero-copy inter-process communication (IPC) library that enables seamless RPC between Bun, Node.js, and Deno using POSIX shared memory and lock-free ring buffers. It exposes a single unified TypeScript API (`serve` / `connect`) regardless of runtime, hiding all FFI, shared memory, and binary protocol complexity.

### Technology stack

| Component          | Language   | Purpose                                          |
| ------------------ | ---------- | ------------------------------------------------ |
| **`src/`**         | TypeScript | Unified high-level API (`serve` / `connect`)     |
| **`core/`**        | Zig        | Lock-free ring buffer, POSIX shm management      |
| **`bun-ffi/`**     | TypeScript | Bun runtime adapter (`bun:ffi`)                  |
| **`deno-plugin/`** | TypeScript | Deno runtime adapter (`Deno.dlopen`)             |
| **`node-addon/`**  | Rust       | Node.js N-API addon                              |
| **`protocol/`**    | TypeScript | FlatMsg serialization, RPC layer, security guard |
| **`tests/`**       | TypeScript | Unit, integration, and security tests            |
| **`examples/`**    | TypeScript | Quickstart and cross-runtime demos               |

---

## Prerequisites

### Required

- **Zig ≥ 0.14** — [Download](https://ziglang.org/download/)

  ```bash
  zig version
  ```

- **Node.js ≥ 20** — [Download](https://nodejs.org/)

  ```bash
  node --version
  ```

### For Node.js support (optional but recommended)

- **Rust ≥ 1.75 (stable)** — [Install](https://rustup.rs/)

  ```bash
  rustc --version && cargo --version
  ```

### For running as server or Deno client

- **Bun ≥ 1.1** — [Install](https://bun.sh/)

  ```bash
  bun --version
  ```

- **Deno ≥ 1.40** — [Install](https://deno.land/)

  ```bash
  deno --version
  ```

### Verify all at once

```bash
zig version && node --version && bun --version && deno --version && rustc --version
```

---

## Project Structure

```
zinc/
├── src/                         # ← Start here: unified high-level API
│   ├── index.ts                 # Public exports: serve(), connect(), detectRuntime()
│   ├── channel.ts               # ZincServer and ZincClient implementations
│   ├── runtime.ts               # Runtime detection + adapter dynamic import
│   ├── types.ts                 # Shared TypeScript types (RingLike, etc.)
│   └── adapters/
│       └── node.ts              # NodeRingAdapter wrapping the N-API addon
│
├── core/                        # Zig core: ring buffer + shm
│   ├── ring_buffer.zig          # Lock-free ring buffer
│   ├── ring_test.zig            # Zig unit tests
│   ├── bench.zig                # Zig benchmark binary
│   ├── build.zig                # Zig build config
│   └── uipc.h                   # C header (used by Rust FFI)
│
├── bun-ffi/                     # Internal: Bun runtime adapter
│   └── index.ts                 # bun:ffi → libuipc_core
│
├── deno-plugin/                 # Internal: Deno runtime adapter
│   └── mod.ts                   # Deno.dlopen → libuipc_core
│
├── node-addon/                  # Internal: Node.js N-API addon (Rust)
│   ├── src/lib.rs               # napi-rs module
│   ├── src/ffi.rs               # FFI wrapper around Zig static lib
│   ├── Cargo.toml
│   └── build.rs                 # Links core/zig-out/lib/libuipc_core.a
│
├── protocol/                    # Binary protocol layer
│   ├── flat_msg.ts              # FlatMsg encode/decode
│   ├── rpc.ts                   # RPCNode: CALL/REPLY correlation
│   ├── pool.ts                  # RingPool manager
│   └── security.ts              # Rate limiting, replay protection
│
├── tests/                       # Test suites
│   ├── flat_msg.test.ts         # FlatMsg tests (Bun)
│   ├── flat_msg_node.mjs        # FlatMsg tests (Node.js)
│   ├── integration_sim.mjs      # RPC integration simulation
│   ├── security.test.mjs        # Security guard tests
│   └── pool.test.mjs            # Connection pool tests
│
├── examples/
│   ├── quickstart/
│   │   ├── server.ts            # Minimal serve() example
│   │   └── client.ts            # Minimal connect() example
│   ├── bun_server.ts            # Full demo server (Bun)
│   ├── deno_client.ts           # Full demo client (Deno)
│   └── node_client.mjs          # Full demo client (Node.js, low-level)
│
├── scripts/
│   ├── build-all.sh             # Build Zig + Rust + typecheck
│   └── bench.sh                 # Run all benchmarks
│
├── package.json                 # Node.js/Bun config (name: "zinc")
├── deno.json                    # Deno config (name: "zinc")
├── tsconfig.json                # TypeScript config
├── README.md                    # User-facing landing page
└── DEVELOPMENT_GUIDE.md         # This file
```

---

## Getting Started

### 1. Clone and install

```bash
git clone https://github.com/your-org/zinc.git
cd zinc
npm install
```

### 2. Build everything

```bash
bash scripts/build-all.sh
```

This produces:

- `core/zig-out/lib/libuipc_core.{dylib,so}` — shared library for Bun and Deno
- `node-addon/target/release/uipc_node.node` — native addon for Node.js

### 3. Verify with quickstart

```bash
# Terminal 1
bun run examples/quickstart/server.ts

# Terminal 2
bun run examples/quickstart/client.ts
```

---

## Running Tests

```bash
# FlatMsg protocol tests (Bun)
bun test tests/flat_msg.test.ts

# FlatMsg protocol tests (Node.js)
node tests/flat_msg_node.mjs

# RPC integration simulation
node tests/integration_sim.mjs

# Security guard tests
node tests/security.test.mjs

# Connection pool tests
node tests/pool.test.mjs

# Zig ring buffer unit tests
cd core && zig build test
```

---

## Running Benchmarks

```bash
bash scripts/bench.sh
```

Or individually:

```bash
# Zig ring buffer raw throughput
cd core && zig build -Doptimize=ReleaseFast && ./zig-out/bin/uipc_bench
```

---

## Running the Demo

Start a Bun server and connect clients from any runtime:

```bash
# Terminal 1 — server
bun run examples/bun_server.ts

# Terminal 2 — Deno client
deno run --allow-ffi --allow-env examples/deno_client.ts

# Terminal 3 — Node.js client (low-level)
node examples/node_client.mjs
```

---

## Development Workflow

### High-level API changes (`src/`)

1. Edit `src/channel.ts`, `src/runtime.ts`, or `src/types.ts`
2. Type-check: `bun run tsc --noEmit`
3. Test via quickstart examples

### Protocol changes (`protocol/`)

1. Edit `protocol/flat_msg.ts` or `protocol/rpc.ts`
2. Run: `bun test tests/flat_msg.test.ts && node tests/integration_sim.mjs`

### Zig core changes (`core/`)

1. Edit `core/ring_buffer.zig`
2. Run Zig tests: `cd core && zig build test`
3. Rebuild: `bash scripts/build-all.sh`
4. Run integration tests: `node tests/integration_sim.mjs`

### Rust N-API addon changes (`node-addon/`)

1. Edit `node-addon/src/lib.rs` or `node-addon/src/ffi.rs`
2. Rebuild: `cd node-addon && UIPC_CORE_LIB=../core/zig-out/lib cargo build --release`
3. Test: `node tests/integration_sim.mjs`

---

## Architecture Deep Dive

### Unified API layer (`src/`)

`src/index.ts` exports `serve()` and `connect()`. These call `src/channel.ts` which:

1. Calls `detectRuntime()` in `src/runtime.ts` to identify Bun / Deno / Node
2. Dynamically imports the correct adapter
3. Wraps the adapter in an `RPCNode` from `protocol/rpc.ts`
4. Returns a `ZincServer` or `ZincClient`

### Lock-free ring buffer (`core/`)

- **Atomic head/tail**: Two 64-bit atomic pointers; no locks
- **Slot-based**: Fixed-size 4096-byte slots; no fragmentation
- **Cache-line aligned**: Each slot is 64-byte aligned to prevent false sharing
- **CRC32**: Each slot is protected by a CRC covering header + payload

### FlatMsg binary protocol (`protocol/flat_msg.ts`)

```
Byte 0:     field_count (u8, max 255)
Bytes 1–N:  Repeated field entries:
  - type_tag  (u8)
  - key_len   (u16 LE)
  - key_bytes (variable)
  - val_len   (u32 LE)
  - val_bytes (variable)
```

Supports 9 value types: `u32`, `u64`, `i32`, `i64`, `f64`, `bool`, `string`, `bytes`, `null`.

### RPC correlation (`protocol/rpc.ts`)

```
Client                          Server
  |--- CALL (msgId, method) ---->|
  |                              |
  |<--- REPLY (correlationId) ---|
```

`RPCNode` maintains a `Map<bigint, { resolve, reject, timer }>` so concurrent calls are safely matched to their replies.

### Runtime adapters

| File                   | Strategy                                        |
| ---------------------- | ----------------------------------------------- |
| `bun-ffi/index.ts`     | `bun:ffi` dlopen → `libuipc_core.{dylib,so}`    |
| `deno-plugin/mod.ts`   | `Deno.dlopen` → `libuipc_core.{dylib,so}`       |
| `src/adapters/node.ts` | `createRequire` → `uipc_node.node` (Rust N-API) |

---

## Common Tasks

### Add a new RPC handler (server)

```ts
server.handle("myMethod", async ({ x, y }) => {
  return (x as number) + (y as number);
});
```

### Call a remote method (client)

```ts
const result = await client.call("myMethod", { x: 10, y: 20 });
```

### Override library paths at runtime

```bash
ZINC_LIB_DIR=/custom/path bun run examples/bun_server.ts
ZINC_NATIVE_DIR=/custom/path node examples/node_client.mjs
```

---

## Troubleshooting

### `zig not found`

Install from https://ziglang.org/download/

### `cargo not found`

Install from https://rustup.rs/ (needed for Node.js support only)

### Build fails: `UIPC_CORE_LIB not set`

Build Zig first, then pass the path manually:

```bash
cd node-addon
UIPC_CORE_LIB=../core/zig-out/lib cargo build --release
```

### Stale shared memory segment

If a server crashes without cleanup, the shm segment may persist. Clear it:

```bash
ls /dev/shm | grep zinc   # Linux
# macOS: segments are in kernel memory; reboot or use ipcs/ipcrm
```

### `bun:ffi` IDE error

This is expected — `bun:ffi` is a virtual module only resolvable at Bun runtime. It does not indicate a real build error.

---

## Contributing

### Code style

- **Zig**: 4-space indent, follow Zig standard library conventions
- **Rust**: `cargo fmt` + `cargo clippy --all-targets`
- **TypeScript**: `bun run tsc --noEmit` must pass with zero errors

### Before submitting a PR

1. `bash scripts/build-all.sh` succeeds
2. All tests pass (see [Running Tests](#running-tests))
3. `bun run tsc --noEmit` is clean
4. Update this guide if adding new components or environment variables

### Commit message format

```
[component] Brief description

Optional longer explanation.

Fixes #123
```

Examples: `[src] Add ZincServer.close() cleanup`, `[core] Fix ring slot alignment`, `[docs] Update quickstart`

---

## FAQ

**Q: What's the max message size?**
A: 4064 bytes per ring slot. Larger messages require chunking at the application level.

**Q: Can Zinc work across machines?**
A: No. POSIX shared memory is local-machine only. For network IPC, use gRPC or similar.

**Q: Can I use Zinc with TypeScript in Node.js?**
A: Yes. Use `tsx` as a loader: `node --import tsx/esm my-script.ts`

**Q: How do I profile performance?**
A: `perf` on Linux, Instruments on macOS, or `bun run --smol` for heap profiling.

---

## Resources

- [Zig Documentation](https://ziglang.org/documentation/)
- [Bun FFI](https://bun.sh/docs/api/ffi)
- [Deno FFI](https://docs.deno.com/runtime/reference/deno_namespace_apis/#deno.dlopen)
- [POSIX Shared Memory](https://man7.org/linux/man-pages/man7/shm_overview.7.html)
- [Lock-Free Programming](https://www.1024cores.net/)
- [napi-rs (Rust N-API)](https://napi.rs/)

---

Happy hacking!
