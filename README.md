# Zinc — cross-process shared memory for JavaScript

> **Experimental.** The native layer is young. Production use is at your own risk.

Zinc gives JavaScript processes direct access to the same physical memory — across Bun, Node.js, and Deno. No serialization, no copies, no kernel round-trips. Just `mmap` under the hood and an `ArrayBuffer` in your hands.

Think `SharedArrayBuffer`, but cross-process.

---

## Why

`SharedArrayBuffer` lets Worker threads share memory within a single process. There's no equivalent across processes. If you want two JS processes to share a large dataset — video frames, ML model outputs, game state, a shared cache — your options are: serialize it, copy it through a socket, deserialize it on the other side. For a 8MB frame at 60fps, that's 480MB/s of pointless copying.

Zinc maps the same physical RAM pages into both processes via POSIX shared memory. Write a float in process A, read it in process B. No syscall, no copy, no serialization. The transfer time is zero because there's nothing to transfer — it's already there.

---

## Quick start

```bash
git clone https://github.com/aspect-build/zinc
cd zinc
bash scripts/build-all.sh   # needs Zig ≥ 0.14; Rust optional (Node.js only)
```

**Process A** — create a shared region and write to it:

```ts
import { sharedBuffer } from "./src/index.ts";

const region = await sharedBuffer("/my-data", 1024 * 1024, true);
const floats = new Float32Array(region.buffer);
floats[0] = 42.0;
floats[1] = 3.14;
```

**Process B** (any runtime) — open the same region:

```ts
import { sharedBuffer } from "./src/index.ts";

const region = await sharedBuffer("/my-data", 1024 * 1024, false);
const floats = new Float32Array(region.buffer);
console.log(floats[0]); // 42.0 — same physical memory
```

That's it. Both processes are reading and writing the same bytes. Use `Atomics` on an `Int32Array` view for synchronization if you need it.

---

## API

### `sharedBuffer(name, size, create): Promise<SharedMemoryRegion>`

The core primitive. Returns an object whose `.buffer` is an `ArrayBuffer` backed by `mmap`'d shared memory.

| Parameter | Type      | Description                                |
| --------- | --------- | ------------------------------------------ |
| `name`    | `string`  | POSIX shm name (e.g. `"/my-region"`)       |
| `size`    | `number`  | Size in bytes                              |
| `create`  | `boolean` | `true` to create, `false` to open existing |

`SharedMemoryRegion` has:

| Property/Method | Description                            |
| --------------- | -------------------------------------- |
| `.buffer`       | The raw `ArrayBuffer` (zero-copy mmap) |
| `.byteLength`   | Size of the region                     |
| `.unlink()`     | Remove the shm segment from the OS     |
| `.close()`      | Unmap and release resources            |

### Legacy RPC: `serve()` / `connect()`

The message-passing API still works for simple request/response patterns where convenience matters more than throughput. See [`RFC-001.md`](./RFC-001.md) for context on when to use which.

```ts
import { serve, connect } from "./src/index.ts";

// Server
const server = await serve("my-service");
server.handle("add", ({ a, b }) => (a as number) + (b as number));

// Client (any runtime)
const client = await connect("my-service");
const sum = await client.call("add", { a: 40, b: 2 }); // 42
```

### Environment variables

| Variable          | Default                     | Description                             |
| ----------------- | --------------------------- | --------------------------------------- |
| `ZINC_LIB_DIR`    | `core/zig-out/lib`          | Path to `libuipc_core.{dylib,so}`       |
| `ZINC_NATIVE_DIR` | `node-addon/target/release` | Path to `uipc_node.node` (Node.js only) |

---

## Architecture

```
  sharedBuffer("/name", size, create)
         │
  Runtime detection  (src/runtime.ts)
         │
  ┌──────┼──────────────┐
  Bun    Deno           Node.js
  bun:ffi  Deno.dlopen  Rust N-API
  │        │             │
  └────────┴─────────────┘
         │
  Zig core  (core/ring_buffer.zig)
  shm_open → mmap → raw pointer
         │
  ArrayBuffer (external, zero-copy)
  backed by the same physical pages
```

Each runtime has its own adapter because each has a completely different FFI model. The adapters are thin — they call into the same Zig C-ABI functions and wrap the returned pointer as a native `ArrayBuffer`.

The legacy ring buffer (lock-free, CRC32-checked, 4KB slots) is still available for message-passing use cases via `serve()`/`connect()`.

---

## Performance

The shared buffer path has no "transfer" to benchmark — both processes access the same RAM. The cost is a single `mmap` setup call, then memory reads/writes at native speed.

For the legacy RPC path:

| Transport              | Typical latency | Notes                           |
| ---------------------- | --------------- | ------------------------------- |
| Zinc ring (shm)        | 50–150 µs       | Lock-free ring, no kernel calls |
| Unix domain socket     | 100–500 µs      | Kernel copies on every message  |
| HTTP/WebSocket (local) | 500 µs – 5 ms   | Full TCP stack                  |

---

## Building

```bash
# Zig ≥ 0.14   https://ziglang.org/download/
# Rust ≥ 1.75  https://rustup.rs/  (Node.js addon only)
# Bun  ≥ 1.1   https://bun.sh/

bash scripts/build-all.sh
```

Outputs:

- `core/zig-out/lib/libuipc_core.{dylib,so}` — loaded by Bun and Deno
- `node-addon/target/release/uipc_node.node` — loaded by Node.js

---

## Security

Zinc runs between same-machine processes. The `SecurityGuard` in `protocol/security.ts` covers:

- CRC32 on every ring slot
- Payload bounds checking
- PID tagging and allowlisting
- Monotonic sequence numbers (replay detection)
- Rate limiting (token bucket per PID)
- shm permissions `0600` by default

---

## Contributing

Open an issue before a big PR. See [`DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md) for build instructions and project structure.

Type-check before submitting: `bun run tsc --noEmit`

---

MIT — see [`LICENSE`](./LICENSE).
