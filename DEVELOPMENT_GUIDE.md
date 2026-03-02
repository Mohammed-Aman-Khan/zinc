# Universal-IPC Bridge — Development Guide

Welcome! This guide will help you set up the project, understand its structure, and start contributing.

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

---

## Project Overview

**Universal-IPC Bridge** is a high-performance, zero-copy inter-process communication (IPC) system that enables seamless communication between Bun, Node.js, and Deno using POSIX shared memory and lock-free ring buffers.

### Key Features

- **Zero-Copy**: Data written once into shared memory, no serialization overhead
- **Lock-Free**: Atomic compare-and-swap operations, no mutexes or blocking
- **Multi-Runtime**: Native adapters for Bun (FFI), Node.js (N-API), and Deno (FFI)
- **Schema-Free**: Custom FlatMsg binary format, no protobuf/schema compilation
- **High Performance**: >1M messages/sec, <1μs latency on same machine

### Technology Stack

| Component        | Language              | Purpose                                     |
| ---------------- | --------------------- | ------------------------------------------- |
| **Core**         | Zig                   | Lock-free ring buffer, POSIX shm management |
| **Bun Adapter**  | TypeScript            | FFI bindings for Bun runtime                |
| **Deno Adapter** | TypeScript            | FFI bindings for Deno runtime               |
| **Node Adapter** | Rust                  | N-API addon for Node.js                     |
| **Protocol**     | TypeScript            | FlatMsg serialization, RPC layer, security  |
| **Tests**        | TypeScript/JavaScript | Unit, integration, security, pool tests     |

---

## Prerequisites

Install these tools before starting:

### Required

- **Zig 0.13.0+** — [Download](https://ziglang.org/download/)

  ```bash
  zig version  # Should output 0.13.0 or later
  ```

- **Rust 1.78+ (stable)** — [Install](https://rustup.rs/)

  ```bash
  rustc --version  # Should output 1.78.0 or later
  cargo --version
  ```

- **Node.js 20+** — [Download](https://nodejs.org/)
  ```bash
  node --version  # Should output v20.0.0 or later
  ```

### Recommended

- **Bun 1.1+** — [Install](https://bun.sh/)

  ```bash
  bun --version  # Should output 1.1.0 or later
  ```

- **Deno 1.40+** — [Install](https://deno.land/)

  ```bash
  deno --version
  ```

- **tmux** — For running the demo in multiple panes
  ```bash
  tmux -V
  ```

### Verify Installation

```bash
# Run this from the project root
zig version && rustc --version && node --version && bun --version && deno --version
```

---

## Project Structure

```
universal-ipc/
├── core/                    # Zig core: ring buffer, shm management
│   ├── ring_buffer.zig      # Lock-free ring buffer implementation
│   ├── ring_test.zig        # Unit tests for ring buffer
│   ├── bench.zig            # Benchmark binary
│   ├── build.zig            # Zig build configuration
│   └── uipc.h               # C header for FFI
│
├── bun-ffi/                 # Bun runtime adapter
│   └── index.ts             # FFI bindings using bun:ffi
│
├── deno-plugin/             # Deno runtime adapter
│   └── mod.ts               # FFI bindings using Deno.dlopen
│
├── node-addon/              # Node.js N-API addon (Rust)
│   ├── src/
│   │   ├── lib.rs           # Main N-API module
│   │   └── ffi.rs           # FFI wrapper around Zig core
│   ├── Cargo.toml           # Rust dependencies
│   └── build.rs             # Build script (links Zig static lib)
│
├── protocol/                # Shared protocol layer
│   ├── flat_msg.ts          # FlatMsg serialization (encode/decode)
│   ├── rpc.ts               # RPC layer (CALL/REPLY pattern)
│   ├── pool.ts              # Connection pool manager
│   └── security.ts          # Security guard (rate limiting, replay protection)
│
├── tests/                   # Test suites
│   ├── flat_msg.test.ts     # FlatMsg protocol tests (Bun)
│   ├── flat_msg_node.mjs    # FlatMsg protocol tests (Node.js)
│   ├── integration_sim.mjs   # RPC integration simulation
│   ├── security.test.mjs    # Security guard tests
│   └── pool.test.mjs        # Connection pool tests
│
├── examples/                # Demo applications
│   ├── bun_server.ts        # Bun server (creates ring, handles RPC)
│   ├── node_client.mjs      # Node.js client
│   └── deno_client.ts       # Deno client
│
├── scripts/                 # Build and run scripts
│   ├── build-all.sh         # Build Zig core + Rust addon + typecheck
│   ├── run-demo.sh          # Launch 3-runtime demo
│   └── bench.sh             # Run all benchmarks
│
├── .github/workflows/       # CI/CD pipeline
│   └── ci.yml               # GitHub Actions workflow
│
├── package.json             # Node.js/Bun scripts and dependencies
├── deno.json                # Deno configuration
├── tsconfig.json            # TypeScript configuration
└── README.md                # Project overview
```

---

## Getting Started

### 1. Clone and Install

```bash
git clone https://github.com/yourusername/universal-ipc.git
cd universal-ipc

# Install Node.js dependencies (TypeScript, types)
npm install
```

### 2. Build Everything

```bash
npm run build
# or
bash scripts/build-all.sh
```

This will:

- Build the Zig core library (`core/zig-out/lib/libuipc_core.so`)
- Build the Rust N-API addon (`node-addon/target/release/uipc_node.node`)
- Type-check all TypeScript files

### 3. Verify Installation

```bash
# Run all tests
npm test                    # Bun tests
node tests/flat_msg_node.mjs
node tests/integration_sim.mjs
node tests/security.test.mjs
node tests/pool.test.mjs
```

All tests should pass ✅

---

## Running Tests

### Unit Tests

#### FlatMsg Protocol (Bun)

```bash
bun test tests/flat_msg.test.ts
```

Tests the binary serialization format: encode/decode roundtrips, type handling, edge cases.

#### FlatMsg Protocol (Node.js)

```bash
node tests/flat_msg_node.mjs
```

Same tests as above, but runs in Node.js (no Bun dependency). Useful for CI.

#### RPC Integration

```bash
node tests/integration_sim.mjs
```

Tests the RPC layer: CALL/REPLY pattern, error handling, concurrent calls, large payloads.

#### Security Guard

```bash
node tests/security.test.mjs
```

Tests rate limiting, replay protection, PID allowlisting, payload size validation.

#### Connection Pool

```bash
node tests/pool.test.mjs
```

Tests the RingPool manager: channel creation, worker round-robin, health tracking.

### Run All Tests at Once

```bash
npm test                    # Bun tests only
# or
bash scripts/test-all.sh    # All tests (if available)
# or manually:
bun test tests/flat_msg.test.ts && \
  node tests/flat_msg_node.mjs && \
  node tests/integration_sim.mjs && \
  node tests/security.test.mjs && \
  node tests/pool.test.mjs
```

### Zig Unit Tests

```bash
npm run test:zig
# or
cd core && zig build test
```

Tests the ring buffer implementation at the C level.

---

## Running Benchmarks

### Quick Benchmarks

```bash
npm run bench
# or
bash scripts/bench.sh
```

This runs:

1. **Zig Ring Buffer Bench** — Raw throughput of the lock-free ring
2. **FlatMsg Serialization Bench** — Encode/decode performance
3. **Summary** — Cross-runtime RPC throughput (see demo)

### Individual Benchmarks

#### Zig Ring Buffer

```bash
cd core
zig build -Doptimize=ReleaseFast
./zig-out/bin/uipc_bench
```

#### FlatMsg Serialization (Bun)

```bash
bun run << 'EOF'
import { encode, decode, v } from "./protocol/flat_msg.ts";

const ITERS = 500_000;
const msg = { method: v.str("add"), a: v.u32(40), b: v.u32(2) };

const t0 = performance.now();
let enc;
for (let i = 0; i < ITERS; i++) enc = encode(msg);
const t1 = performance.now();

console.log(`Encode: ${(ITERS / ((t1 - t0) / 1000) / 1e6).toFixed(2)}M msg/sec`);
EOF
```

---

## Running the Demo

The demo launches three runtimes communicating over a shared ring buffer.

### Prerequisites

Build first:

```bash
npm run build
```

### Launch Demo

```bash
npm run demo
# or
bash scripts/run-demo.sh
```

**With tmux** (recommended):

- Opens 3 panes: Bun Server, Node Client, Deno Client
- Attach with `tmux attach -t uipc`
- Detach with `Ctrl-B D`
- Kill with `tmux kill-session -t uipc`

**Without tmux**:

- Runs sequentially: Bun server in background, then Node client, then Deno client
- Press Ctrl-C to stop

### What the Demo Does

1. **Bun Server** (`examples/bun_server.ts`)
   - Creates a shared ring buffer at `/uipc_demo_ring`
   - Registers RPC handlers: `ping`, `add`, `echo`, `fibonacci`, `greet`
   - Polls for incoming calls and sends replies

2. **Node Client** (`examples/node_client.mjs`)
   - Connects to the ring
   - Makes RPC calls: `ping()`, `add(40, 2)`, `echo("Hello")`, etc.
   - Prints results

3. **Deno Client** (`examples/deno_client.ts`)
   - Same as Node client, but using Deno runtime
   - Demonstrates cross-runtime communication

---

## Development Workflow

### Making Changes to the Core (Zig)

1. Edit `core/ring_buffer.zig`
2. Run tests: `npm run test:zig`
3. Rebuild: `npm run build`
4. Run integration tests: `node tests/integration_sim.mjs`

### Making Changes to the Protocol (TypeScript)

1. Edit `protocol/flat_msg.ts`, `protocol/rpc.ts`, etc.
2. Run tests: `npm test` (Bun) or `node tests/flat_msg_node.mjs` (Node)
3. Type-check: `npm run typecheck`

### Making Changes to the Node Adapter (Rust)

1. Edit `node-addon/src/lib.rs` or `node-addon/src/ffi.rs`
2. Rebuild: `npm run build`
3. Test: `node tests/integration_sim.mjs`

### Making Changes to Examples

1. Edit `examples/bun_server.ts`, `examples/node_client.mjs`, etc.
2. Run demo: `npm run demo`

### Adding a New Test

1. Create `tests/my_feature.test.ts` (for Bun) or `tests/my_feature.mjs` (for Node)
2. Import from `protocol/` as needed
3. Run: `bun test tests/my_feature.test.ts` or `node tests/my_feature.mjs`

---

## Architecture Deep Dive

### Lock-Free Ring Buffer

Located in `core/ring_buffer.zig`. Key concepts:

- **Atomic Head/Tail**: Two 64-bit atomic pointers track producer and consumer positions
- **Slot-Based**: Fixed-size slots (4096 bytes) prevent fragmentation
- **No Locks**: Uses atomic CAS (compare-and-swap) for synchronization
- **Cache-Line Aligned**: Each slot is 64-byte aligned to prevent false sharing

### FlatMsg Protocol

Located in `protocol/flat_msg.ts`. Wire format:

```
Byte 0:        field_count (u8)
Bytes 1-N:     Repeated fields:
  - type_tag (u8)
  - key_len (u16 LE)
  - key_bytes (variable)
  - value_len (u32 LE)
  - value_bytes (variable)
```

Supports 9 types: u32, u64, i32, i64, f64, bool, string, bytes, null.

**Constraint**: Max 255 fields per message (field_count is u8).

### RPC Layer

Located in `protocol/rpc.ts`. Pattern:

```
Client                          Server
  |                               |
  |--- CALL (method, args) ------>|
  |                               |
  |<---- REPLY (result/error) ----|
  |                               |
```

Uses `correlationId` to match replies to calls.

### Security Guard

Located in `protocol/security.ts`. Features:

- **Rate Limiting**: Token bucket per PID
- **Replay Protection**: Monotonic message IDs
- **PID Allowlisting**: Optional whitelist of sender PIDs
- **Payload Size Validation**: Reject oversized messages

---

## Common Tasks

### Task: Add a New RPC Method

1. **Server side** (`examples/bun_server.ts`):

   ```typescript
   server.register("myMethod", async (args) => {
     return args.x + args.y;
   });
   ```

2. **Client side** (`examples/node_client.mjs`):
   ```javascript
   const result = await client.call("myMethod", { x: 10, y: 20 });
   console.log(result); // 30
   ```

### Task: Increase Ring Buffer Size

1. Edit `core/ring_buffer.zig`, find `const RING_SIZE = ...`
2. Change to desired size (must be power of 2)
3. Rebuild: `npm run build`
4. Run tests to verify

### Task: Add a New Type to FlatMsg

1. Edit `protocol/flat_msg.ts`:
   - Add tag to `TAG` object
   - Add case to `encodeValue()` and `decodeValue()`
   - Update `FlatValue` type

2. Run tests: `npm test`

### Task: Profile Performance

```bash
# Zig ring buffer
npm run bench

# FlatMsg serialization
bun run scripts/bench.sh

# RPC throughput
npm run demo  # Watch the output for throughput metrics
```

### Task: Debug a Test Failure

```bash
# Run with verbose output
bun test tests/flat_msg.test.ts --verbose

# Or add console.log to the test file
# Then run
node tests/my_test.mjs
```

### Task: Check TypeScript Types

```bash
npm run typecheck
```

---

## Troubleshooting

### "zig not found"

Install Zig: https://ziglang.org/download/

### "cargo not found"

Install Rust: https://rustup.rs/

### "bun not found"

Install Bun: https://bun.sh/ (optional, but recommended)

### Build fails with "UIPC_CORE_LIB not set"

The Rust build script needs the Zig library path. This is set automatically by `npm run build`, but if building manually:

```bash
cd node-addon
UIPC_CORE_LIB=../core/zig-out/lib cargo build --release
```

### Demo hangs or crashes

- Ensure all three runtimes are installed (Bun, Node, Deno)
- Check that `/dev/shm` is writable
- Kill any stale processes: `pkill -f "bun run examples/bun_server"`

### Tests fail with "field count wrong"

The FlatMsg protocol uses a u8 for field_count, limiting to 255 fields max. Tests use 200 fields to stay within this limit.

---

## Environment Variables

### Build-Time

- `UIPC_CORE_LIB` — Path to Zig core library (default: `../core/zig-out/lib`)
  ```bash
  UIPC_CORE_LIB=/path/to/lib cargo build --release
  ```

### Runtime

- `UIPC_LIB_DIR` — Override shared library path (Bun/Deno)
  ```bash
  UIPC_LIB_DIR=/custom/path bun run examples/bun_server.ts
  ```

---

## Performance Targets

| Metric          | Target          | Typical                 |
| --------------- | --------------- | ----------------------- |
| Ring throughput | >1M msg/sec     | 1.2M msg/sec            |
| RPC latency     | <1μs round-trip | 11μs (with JS overhead) |
| Serialization   | >1M msg/sec     | 0.5-1.2M msg/sec        |
| Security checks | >1M/sec         | 3.4M verifications/sec  |

---

## Contributing

### Code Style

- **Zig**: Follow Zig conventions (2-space indent)
- **Rust**: Run `cargo fmt` and `cargo clippy`
- **TypeScript**: Run `npm run typecheck`

### Before Submitting a PR

1. Run all tests: `npm test && npm run test:zig`
2. Run benchmarks: `npm run bench`
3. Type-check: `npm run typecheck`
4. Update DEVELOPMENT_GUIDE.md if adding new features

### Commit Message Format

```
[component] Brief description

Longer explanation if needed.

Fixes #123
```

Examples:

- `[core] Optimize ring buffer alignment`
- `[protocol] Add new RPC method type`
- `[tests] Add security guard edge case`

---

## FAQ

**Q: Can I use this in production?**
A: The project is in active development (v0.1.0). Use at your own risk. Contributions welcome!

**Q: What's the max message size?**
A: 4064 bytes (payload size in a ring slot). Larger messages require chunking.

**Q: Can I use this across machines?**
A: No, POSIX shared memory is local-machine only. For network IPC, consider gRPC or similar.

**Q: How do I debug a hanging RPC call?**
A: Add timeouts to client calls. Check server logs. Ensure server is running and polling.

**Q: Can I use this with TypeScript in Node.js?**
A: Yes, but you'll need to compile TS to JS first. Use `tsx` or `ts-node` for development.

**Q: How do I profile the ring buffer?**
A: Use `perf` on Linux or Instruments on macOS. See `core/bench.zig` for a reference benchmark.

---

## Resources

- **Zig Documentation**: https://ziglang.org/documentation/
- **Rust FFI**: https://doc.rust-lang.org/nomicon/ffi.html
- **POSIX Shared Memory**: https://man7.org/linux/man-pages/man7/shm_overview.7.html
- **Lock-Free Programming**: https://www.1024cores.net/
- **Bun FFI**: https://bun.sh/docs/api/ffi
- **Deno FFI**: https://deno.land/manual/runtime/ffi_api

---

## Next Steps

- Read [README.md](README.md) for architecture overview
- Explore `core/ring_buffer.zig` to understand the lock-free algorithm
- Study `protocol/flat_msg.ts` to learn the serialization format
- Run the demo and observe cross-runtime communication
- Write a custom RPC handler in `examples/bun_server.ts`
- Join discussions and contribute improvements!

Happy hacking! 🚀
