# Universal-IPC Bridge ⚡

> Zero-copy, lock-free inter-runtime communication between Bun, Node.js, and Deno at RAM speed.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  POSIX Shared Memory                    │
│  ┌──────────────────────────────────────────────────┐   │
│  │           Lock-Free Ring Buffer                  │   │
│  │  ┌────────┬────────┬────────┬────────┬────────┐  │   │
│  │  │ Slot 0 │ Slot 1 │ Slot 2 │  ...   │Slot N-1│  │   │
│  │  └────────┴────────┴────────┴────────┴────────┘  │   │
│  │  head(atomic u64)              tail(atomic u64)   │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
         ▲                    ▲                  ▲
         │                    │                  │
  ┌──────┴──┐          ┌──────┴──┐        ┌──────┴──┐
  │  Bun    │          │ Node.js │        │  Deno   │
  │ Zig FFI │          │Rust NAPI│        │Rust NAPI│
  └─────────┘          └─────────┘        └─────────┘
```

## Core Design Principles

1. **Zero-Copy**: Data is written once into shared memory. No serialization copies.
2. **Lock-Free**: Uses atomic compare-and-swap for head/tail pointers. No mutexes.
3. **Cache-Line Aligned**: Each slot is 64-byte aligned to prevent false sharing.
4. **PB-less Serialization**: Custom flat binary layout — no schema compilation needed.
5. **Native Plugins**: Each runtime gets a thin native shim that maps shm directly into its heap.

## Wire Format (FlatMsg)

```
Offset  Size  Field
──────────────────────────────────
0       1     magic (0xIB)
1       1     version (0x01)
2       2     flags (reserved)
4       4     payload_len (u32 LE)
8       8     msg_id (u64 LE)
16      8     correlation_id (u64 LE)
24      1     msg_type (u8)
25      7     padding (reserved)
32      N     payload (raw bytes)
```

## Message Types

| Type  | Value | Meaning               |
| ----- | ----- | --------------------- |
| CALL  | 0x01  | RPC call request      |
| REPLY | 0x02  | RPC reply             |
| EVENT | 0x03  | Fire-and-forget event |
| PING  | 0x04  | Heartbeat             |
| PONG  | 0x05  | Heartbeat reply       |
| ERROR | 0xFF  | Error response        |

## Performance Targets

- Throughput: >1M messages/sec (single producer, single consumer)
- Latency: <1μs round-trip on same machine
- Memory: Zero heap allocation in hot path

## Building

### Prerequisites

- Zig 0.13+
- Rust 1.78+ (stable)
- Node.js 20+
- Bun 1.1+

### Build All

```bash
./scripts/build-all.sh
```

### Run Demo

```bash
./scripts/run-demo.sh
```

## Security Model

- **Permissions**: shm segment created with 0600 (owner only). Use groups for multi-user.
- **Poison Detection**: Each slot has a 32-bit CRC32 covering the header + payload.
- **Bounds Checking**: Payload length validated against slot size before any copy.
- **PID Tagging**: Every message is tagged with sender PID, enabling origin verification.
- **Sequence Numbers**: Monotonic msg_id prevents replay.
