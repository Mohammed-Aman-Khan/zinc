# ⚡ Zinc — Universal IPC Bridge for JS Runtimes

> Zero-copy, lock-free inter-process communication between **Bun**, **Node.js**, and **Deno** — on the same machine, at native speed.

---

## Why Zinc?

Modern JS projects often span multiple runtimes. Your API server runs on Bun for speed, your build pipeline runs on Node.js for its ecosystem, your scripts run on Deno for security — and they need to talk to each other.

Before Zinc, here is what developers had to deal with:

| Pain point            | Before Zinc                                                          | With Zinc                                                  |
| --------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| **FFI glue**          | Write runtime-specific FFI code for Bun, Node, and Deno separately   | One `serve()` / `connect()` call, runtime auto-detected    |
| **Shared memory**     | Manually manage POSIX `shm_open`, ring buffers, CRC, alignment       | Fully abstracted — zero native code required               |
| **Protocol**          | Hand-roll a binary wire format or pay the cost of JSON serialization | Built-in zero-copy binary encoding (flat_msg)              |
| **Cross-runtime IPC** | Bun↔Node requires a socket, a file, or a hacky pipe                  | Direct shared memory — no sockets, no OS round-trips       |
| **Latency**           | HTTP/WebSocket/IPC sockets add 0.1–1 ms of latency per call          | Sub-100 µs round-trips via shared memory ring buffer       |
| **Request-reply**     | Manual correlation ID tracking, timeout handling, error propagation  | Automatic — `await client.call("method", args)` just works |

---

## Quick start

### 1. Build the native layer (once)

```bash
git clone https://github.com/your-org/zinc
cd zinc
bash scripts/build-all.sh
```

Requires: **Zig ≥ 0.14** (for the ring buffer core) and optionally **Rust / cargo** (for the Node.js N-API addon).

### 2. Start a server — in any runtime

```ts
// server.ts — run with: bun server.ts  OR  deno run --allow-ffi --allow-env server.ts
import { serve } from "./src/index.ts";

const server = await serve("my-service");

server
  .handle("add", ({ a, b }) => (a as number) + (b as number))
  .handle("ping", () => "pong")
  .onEvent("log", ({ message }) => console.log("[log]", message));

console.log("Server ready.");
```

### 3. Connect a client — from any runtime

```ts
// client.ts — run with: bun client.ts  OR  deno run --allow-ffi --allow-env client.ts
import { connect } from "./src/index.ts";

const client = await connect("my-service");

const sum = await client.call("add", { a: 40, b: 2 }); // → 42
const pong = await client.call("ping"); // → 'pong'

client.emit("log", { message: "Hello from the client!" });

client.close();
```

That's the entire API. No configuration. No runtime-specific code.

---

## Cross-runtime example

```
Terminal 1 (Bun server):
  bun run examples/bun_server.ts

Terminal 2 (Deno client):
  deno run --allow-ffi --allow-env examples/deno_client.ts

Terminal 3 (Node.js client):
  node examples/node_client.mjs
```

All three processes share the same ring buffer and communicate directly through shared memory — no network stack, no serialization overhead.

---

## API reference

### `serve(channelName, options?): Promise<ZincServer>`

Creates a server on the named channel. Opens the shared-memory ring buffer, starts polling, and returns a `ZincServer`.

**`ZincServer` methods:**

| Method                | Description                                                              |
| --------------------- | ------------------------------------------------------------------------ |
| `.handle(method, fn)` | Register an RPC handler. `fn` may be async. Returns `this` for chaining. |
| `.onEvent(event, fn)` | Subscribe to a fire-and-forget event. Returns `this`.                    |
| `.close()`            | Stop polling and release all native resources.                           |

### `connect(channelName, options?): Promise<ZincClient>`

Connects to an existing server. Attaches to the shared-memory ring buffer and starts polling for replies.

**`ZincClient` methods:**

| Method                             | Description                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `.call(method, args?, timeoutMs?)` | Call a remote method. Returns `Promise<unknown>`. Throws on timeout or remote error. |
| `.emit(event, data?)`              | Fire-and-forget event. Does not wait for acknowledgement.                            |
| `.close()`                         | Stop polling and release all native resources.                                       |

---

## Environment variables

| Variable          | Default                     | Description                                          |
| ----------------- | --------------------------- | ---------------------------------------------------- |
| `ZINC_LIB_DIR`    | `core/zig-out/lib`          | Override the path to `libuipc_core.{dylib,so}`       |
| `ZINC_NATIVE_DIR` | `node-addon/target/release` | Override the path to `uipc_node.node` (Node.js only) |
| `UIPC_LIB_DIR`    | —                           | Backward-compatible alias for `ZINC_LIB_DIR`         |

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                       Your application                         │
│                                                                │
│   import { serve, connect } from './src/index.ts'             │
└────────────────────┬─────────────────────┬─────────────────────┘
                     │                     │
          ┌──────────▼──────────┐ ┌────────▼────────────┐
          │    ZincServer       │ │    ZincClient        │
          │   serve(name)       │ │   connect(name)      │
          └──────────┬──────────┘ └────────┬─────────────┘
                     │                     │
          ┌──────────▼─────────────────────▼─────────────┐
          │          RPCNode (protocol/rpc.ts)            │
          │  call() / register() / onEvent() / emit()    │
          └──────────────────────┬────────────────────────┘
                                 │
          ┌──────────────────────▼────────────────────────┐
          │         Runtime adapter (auto-detected)       │
          │  Bun:  bun:ffi → libuipc_core.dylib/.so      │
          │  Deno: Deno.dlopen → libuipc_core             │
          │  Node: N-API Rust addon → uipc_node.node      │
          └──────────────────────┬────────────────────────┘
                                 │
          ┌──────────────────────▼────────────────────────┐
          │      POSIX Shared Memory (shm_open)           │
          │     Lock-free ring buffer (Zig core)          │
          │     Zero-copy · CRC32 · atomic ops only       │
          └───────────────────────────────────────────────┘
```

---

## Performance

Zinc bypasses the OS network stack entirely. Messages travel through RAM — as fast as your CPU cache.

| Transport                  | Typical latency | Notes                              |
| -------------------------- | --------------- | ---------------------------------- |
| Zinc (same machine)        | 50–150 µs       | Shared memory, lock-free ring      |
| Unix domain socket         | 100–500 µs      | Kernel involvement on each syscall |
| HTTP/WebSocket (localhost) | 500 µs – 5 ms   | Full TCP stack                     |
| JSON over HTTP             | 1–20 ms         | Includes serialization cost        |

Throughput: **>100,000 calls/sec** for small payloads on typical hardware.

---

## Supported runtimes

| Runtime | Min version | Transport                          |
| ------- | ----------- | ---------------------------------- |
| Bun     | ≥ 1.1.0     | `bun:ffi` → Zig shared library     |
| Node.js | ≥ 20.0.0    | Rust N-API addon (`cargo build`)   |
| Deno    | ≥ 1.40      | `Deno.dlopen` → Zig shared library |

---

## Building from source

```bash
# Prerequisites
#   zig   ≥ 0.14   https://ziglang.org/download/
#   cargo ≥ 1.75   https://rustup.rs/         (Node.js support only)
#   bun   ≥ 1.1    https://bun.sh/

bash scripts/build-all.sh
```

This produces:

- `core/zig-out/lib/libuipc_core.{dylib,so}` — shared library for Bun and Deno
- `node-addon/target/release/uipc_node.node` — native addon for Node.js

---

## Security model

- **Permissions**: shm segment created with `0600` (owner only). Use groups for multi-user.
- **Poison detection**: Each slot has a 32-bit CRC32 covering the header + payload.
- **Bounds checking**: Payload length validated against slot size before any copy.
- **PID tagging**: Every message is tagged with sender PID, enabling origin verification.
- **Sequence numbers**: Monotonic `msg_id` prevents replay.

---

## Contributing

Contributions are welcome! Please open an issue before submitting a large PR.

- See [`DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md) for architecture details and contribution guidelines.
- Run type-check: `bun run tsc --noEmit`

---

## License

MIT — see [`LICENSE`](./LICENSE).
