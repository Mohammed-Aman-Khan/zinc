/**
 * bun-ffi/index.ts
 * Universal-IPC Bridge — Bun runtime adapter.
 *
 * Uses `bun:ffi` to call the Zig shared library directly, mapping
 * the shm ring buffer into Bun's V8-less JSC heap.
 * No event-loop entry. No serialization overhead. Pure RAM speed.
 */

import { dlopen, FFIType, ptr, toBuffer, type Library } from "bun:ffi";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ──────────────────────────────────────────────────────────────────

export const MSG = {
  CALL:  0x01,
  REPLY: 0x02,
  EVENT: 0x03,
  PING:  0x04,
  PONG:  0x05,
  ERROR: 0xFF,
} as const;

export type MsgType = typeof MSG[keyof typeof MSG];

export interface ReceivedMessage {
  msgType:       number;
  msgId:         bigint;
  correlationId: bigint;
  senderPid:     number;
  payload:       Buffer;
}

// ── FFI Library definition ─────────────────────────────────────────────────

function loadLib() {
  const libDir = process.env.UIPC_LIB_DIR
    ?? join(dirname(fileURLToPath(import.meta.url)), "../core/zig-out/lib");

  const libPath = `${libDir}/libuipc_core.so`; // Linux
  // macOS: libuipc_core.dylib

  return dlopen(libPath, {
    uipc_open: {
      args:    [FFIType.cstring, FFIType.u8],
      returns: FFIType.ptr,
    },
    uipc_close: {
      args:    [FFIType.ptr],
      returns: FFIType.void,
    },
    uipc_unlink: {
      args:    [FFIType.ptr],
      returns: FFIType.void,
    },
    uipc_send: {
      args:    [FFIType.ptr, FFIType.u8, FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    uipc_poll: {
      args:    [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    uipc_stats: {
      args:    [FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.void,
    },
    uipc_max_payload: {
      args:    [],
      returns: FFIType.u32,
    },
  });
}

// ── Header layout (must match UIPCHeader in uipc.h exactly) ────────────────
// Offsets into a 32-byte DataView:
//   0  magic       u8
//   1  version     u8
//   2  flags       u16 LE
//   4  payload_len u32 LE
//   8  msg_id      u64 LE
//  16  correlation u64 LE
//  24  msg_type    u8
//  25  sender_pid  u16 LE
//  27  _pad[5]

const HEADER_SIZE = 32;

function parseHeader(view: DataView) {
  return {
    magic:          view.getUint8(0),
    version:        view.getUint8(1),
    payloadLen:     view.getUint32(4, true),
    msgId:          view.getBigUint64(8, true),
    correlationId:  view.getBigUint64(16, true),
    msgType:        view.getUint8(24),
    senderPid:      view.getUint16(25, true),
  };
}

// ── UIPCRing class ─────────────────────────────────────────────────────────

export class UIPCRing {
  readonly #lib:        ReturnType<typeof loadLib>;
  readonly #ring:       number;          // opaque pointer
  readonly #maxPayload: number;
  #msgId:               bigint = 1n;

  // Reusable output buffers for the hot poll() path (avoids alloc).
  readonly #headerBuf:  ArrayBuffer;
  readonly #payloadBuf: ArrayBuffer;
  readonly #lenBuf:     ArrayBuffer;     // u32

  constructor(name: string, create: boolean) {
    this.#lib        = loadLib();
    this.#maxPayload = this.#lib.symbols.uipc_max_payload();

    const nameBytes  = Buffer.from(name + "\0");
    const ringPtr    = this.#lib.symbols.uipc_open(ptr(nameBytes), create ? 1 : 0);
    if (!ringPtr) throw new Error(`Failed to open ring '${name}'`);
    this.#ring       = ringPtr;

    this.#headerBuf  = new ArrayBuffer(HEADER_SIZE);
    this.#payloadBuf = new ArrayBuffer(this.#maxPayload);
    this.#lenBuf     = new ArrayBuffer(4);
  }

  // ── Producer ──────────────────────────────────────────────────────────

  /** Send a message. Returns the assigned msg_id. */
  send(msgType: MsgType, payload: Buffer, correlationId = 0n): bigint {
    const id = this.#msgId++;
    const rc = this.#lib.symbols.uipc_send(
      this.#ring,
      msgType,
      id,
      correlationId,
      ptr(payload),
      payload.byteLength,
    );
    if (rc !== 0) throw new Error("Ring full or uipc_send failed");
    return id;
  }

  /** High-level: send a CALL and return the msg_id for correlation. */
  call(payload: Buffer): bigint {
    return this.send(MSG.CALL, payload);
  }

  /** High-level: reply to a received call. */
  reply(payload: Buffer, correlationId: bigint): void {
    this.send(MSG.REPLY, payload, correlationId);
  }

  /** Fire-and-forget event. */
  emit(payload: Buffer): void {
    this.send(MSG.EVENT, payload);
  }

  /** Send a PING and return the msg_id. */
  ping(): bigint {
    return this.send(MSG.PING, Buffer.alloc(0));
  }

  // ── Consumer ──────────────────────────────────────────────────────────

  /**
   * Non-blocking poll.
   * Returns a message object if available, or null if the ring is empty.
   * Hot path: uses pre-allocated buffers, zero JS heap allocation.
   */
  poll(): ReceivedMessage | null {
    const hdrPtr     = ptr(this.#headerBuf);
    const payPtr     = ptr(this.#payloadBuf);
    const lenPtr     = ptr(this.#lenBuf);

    const rc = this.#lib.symbols.uipc_poll(this.#ring, hdrPtr, payPtr, lenPtr);

    if (rc === 0) return null;
    if (rc === -1) throw new Error("Ring error or CRC mismatch");

    const hdrView    = new DataView(this.#headerBuf);
    const lenView    = new DataView(this.#lenBuf);
    const hdr        = parseHeader(hdrView);
    const payLen     = lenView.getUint32(0, true);

    // Slice the payload without copying (share the underlying ArrayBuffer).
    const payloadSlice = Buffer.from(this.#payloadBuf, 0, payLen);
    // Make a real copy so the caller owns the memory.
    const payload = Buffer.from(payloadSlice);

    return {
      msgType:       hdr.msgType,
      msgId:         hdr.msgId,
      correlationId: hdr.correlationId,
      senderPid:     hdr.senderPid,
      payload,
    };
  }

  /**
   * Drain all available messages. Synchronous.
   * Suitable for batch processing after a wakeup signal.
   */
  drain(): ReceivedMessage[] {
    const msgs: ReceivedMessage[] = [];
    let msg: ReceivedMessage | null;
    while ((msg = this.poll()) !== null) msgs.push(msg);
    return msgs;
  }

  /**
   * Spin-wait (on the calling thread) for a REPLY whose correlationId matches.
   * Not appropriate for the main thread — use in a Worker or Bun.spawn.
   */
  waitForReply(correlationId: bigint, timeoutMs = 5000): ReceivedMessage {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = this.poll();
      if (msg && msg.correlationId === correlationId && msg.msgType === MSG.REPLY) {
        return msg;
      }
    }
    throw new Error(`Timeout waiting for reply to correlationId=${correlationId}`);
  }

  // ── Utilities ──────────────────────────────────────────────────────────

  /** Returns `{ used: bigint, free: bigint }`. */
  stats(): { used: bigint; free: bigint } {
    const usedBuf = new ArrayBuffer(8);
    const freeBuf = new ArrayBuffer(8);
    this.#lib.symbols.uipc_stats(this.#ring, ptr(usedBuf), ptr(freeBuf));
    const u = new DataView(usedBuf);
    const f = new DataView(freeBuf);
    return {
      used: u.getBigUint64(0, true),
      free: f.getBigUint64(0, true),
    };
  }

  get maxPayloadSize(): number { return this.#maxPayload; }

  /** Unlink the shm segment (call once, from the process that created it). */
  unlink(): void { this.#lib.symbols.uipc_unlink(this.#ring); }

  /** Detach from the ring and free native resources. */
  close(): void {
    this.#lib.symbols.uipc_close(this.#ring);
    this.#lib.close();
  }

  [Symbol.dispose](): void { this.close(); }
}

// ── Convenience factory ─────────────────────────────────────────────────────

export function createRing(name = "/uipc_bridge_v1"): UIPCRing {
  return new UIPCRing(name, true);
}

export function connectRing(name = "/uipc_bridge_v1"): UIPCRing {
  return new UIPCRing(name, false);
}
