# ⚡ Zinc — IPC bridge for JS runtimes

> **This is an experimental project.** The API is stable enough to use, but the native layer is still young. Production use is at your own risk (and honestly, that's kind of the point).

Zero-copy, lock-free IPC between **Bun**, **Node.js**, and **Deno** — on the same machine, at RAM speed.

---

## The problem

Modern JS setups often span multiple runtimes. Bun for the hot API path, Node for the ecosystem, Deno for the sandboxed scripts — and they all need to talk. Before Zinc, your options were basically: Unix sockets (kernel round-trips), HTTP (full TCP stack), or some file-based hack. None of them are free.

Zinc uses POSIX shared memory and a lock-free ring buffer to route messages between processes without ever touching the network stack. Messages go through RAM, not the kernel's socket layer. The latency difference is real.

---

## Quick start

```bash
git clone https://github.com/your-org/zinc
cd zinc
bash scripts/build-all.sh   # needs Zig ≥ 0.14; Rust optional (Node.js only)
```

**Server** (any runtime):

```ts
import { serve } from "./src/index.ts";

const server = await serve("my-service");

server
  .handle("add", ({ a, b }) => (a as number) + (b as number))
  .handle("ping", () => "pong")
  .onEvent("log", ({ message }) => console.log("[log]", message));
```

**Client** (any other runtime, or the same one):

```ts
import { connect } from "./src/index.ts";

const client = await connect("my-service");

const sum = await client.call("add", { a: 40, b: 2 }); // → 42
client.emit("log", { message: "hello from the other side" });
client.close();
```

That's the whole API surface for 95% of use cases.

---

## Cross-runtime demo

```
# Terminal 1 — Bun server
bun run examples/bun_server.ts

# Terminal 2 — Deno client
deno run --allow-ffi --allow-env examples/deno_client.ts

# Terminal 3 — Node.js client
node examples/node_client.mjs
```

All three hit the same ring buffer through shared memory. No network, no serialization overhead beyond our own tiny binary format.

---

## API

### `serve(channelName, options?): Promise<ZincServer>`

Opens (or creates) the shared-memory ring and starts polling. Returns a server you can chain handlers onto.

| Method                | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `.handle(method, fn)` | Register an RPC handler. `fn` can be async. Chainable. |
| `.onEvent(event, fn)` | Subscribe to fire-and-forget events. Chainable.        |
| `.close()`            | Stop polling, release native resources.                |

### `connect(channelName, options?): Promise<ZincClient>`

Attaches to an existing server's ring and starts polling for replies.

| Method                             | Description                                                              |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `.call(method, args?, timeoutMs?)` | RPC call. Returns `Promise<unknown>`. Throws on timeout or remote error. |
| `.emit(event, data?)`              | Fire-and-forget. No reply expected.                                      |
| `.close()`                         | Stop polling, release native resources.                                  |

### Environment variables

| Variable          | Default                     | Description                                |
| ----------------- | --------------------------- | ------------------------------------------ |
| `ZINC_LIB_DIR`    | `core/zig-out/lib`          | Path to `libuipc_core.{dylib,so}`          |
| `ZINC_NATIVE_DIR` | `node-addon/target/release` | Path to `uipc_node.node` (Node.js only)    |
| `UIPC_LIB_DIR`    | —                           | Alias for `ZINC_LIB_DIR` (backward compat) |

---

## Architecture

```
  Your code
  import { serve, connect } from './src/index.ts'
         │                  │
   ZincServer           ZincClient
         └──────┬──────────┘
            RPCNode  (protocol/rpc.ts)
                │
        Runtime adapter  (auto-detected)
          Bun  → bun:ffi   → libuipc_core.dylib
          Deno → Deno.dlopen → libuipc_core.so
          Node → Rust N-API → uipc_node.node
                │
        POSIX shared memory
        Lock-free ring buffer (Zig)
        CRC32 · atomic ops · 4 KB slots
```

The layering is intentional. `RPCNode` knows nothing about Bun or Deno — it only sees `RingLike`. The adapters know nothing about RPC — they only do send/poll. This makes each layer easy to test in isolation and easy to swap (e.g., adding a Windows named-pipe backend later wouldn't touch the protocol layer).

---

## Performance

Zinc skips the OS network stack entirely, so the latency floor is basically "how fast can two processes hit the same cache line."

| Transport              | Typical latency | Notes                           |
| ---------------------- | --------------- | ------------------------------- |
| Zinc (shared memory)   | 50–150 µs       | Lock-free ring, no kernel calls |
| Unix domain socket     | 100–500 µs      | Kernel copies on every message  |
| HTTP/WebSocket (local) | 500 µs – 5 ms   | Full TCP stack                  |

Throughput is north of 100k calls/sec for small payloads. The Zig benchmark (`bash scripts/bench.sh`) will tell you what your hardware can actually do.

---

## Security

Zinc is not a network protocol, but it does run between processes that may have different trust levels, so there's a `SecurityGuard` in `protocol/security.ts`:

- **CRC32** on every slot — detects a corrupt or torn write before any data reaches your handler
- **Payload bounds** — checked before any copy
- **PID tagging** — every message carries sender PID; you can allowlist specific processes
- **Monotonic sequence numbers** — replay detection per sender PID
- **Rate limiting** — token bucket per PID, configurable
- **shm permissions** — `0600` by default (owner only)

---

## Building

```bash
# Zig ≥ 0.14   https://ziglang.org/download/
# Rust ≥ 1.75  https://rustup.rs/  (Node.js addon only)
# Bun  ≥ 1.1   https://bun.sh/

bash scripts/build-all.sh
```

Outputs:

- `core/zig-out/lib/libuipc_core.{dylib,so}` — for Bun and Deno
- `node-addon/target/release/uipc_node.node` — for Node.js

---

## Contributing

Open an issue before a big PR — let's talk about it first. For everything else, see [`DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md).

Type-check before submitting: `bun run tsc --noEmit`

---

MIT — see [`LICENSE`](./LICENSE).
