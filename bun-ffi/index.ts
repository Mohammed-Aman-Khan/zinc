/**
 * bun-ffi/index.ts — Bun runtime adapter.
 * Calls the Zig shared library via bun:ffi. Hot path uses pre-allocated
 * buffers so poll() does zero JS heap allocation per message.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { Buffer } from "node:buffer";

export const MSG = {
  CALL: 0x01,
  REPLY: 0x02,
  EVENT: 0x03,
  PING: 0x04,
  PONG: 0x05,
  ERROR: 0xff,
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

export interface ReceivedMessage {
  msgType: number;
  msgId: bigint;
  correlationId: bigint;
  senderPid: number;
  payload: Buffer;
}

function loadLib() {
  const libDir =
    process.env.ZINC_LIB_DIR ??
    process.env.UIPC_LIB_DIR ?? // backward-compat alias
    join(dirname(fileURLToPath(import.meta.url)), "../core/zig-out/lib");

  // Resolve platform-specific shared library extension.
  const ext = process.platform === "darwin" ? "dylib" : "so";
  const libPath = `${libDir}/libuipc_core.${ext}`;

  return dlopen(libPath, {
    uipc_open: {
      args: [FFIType.cstring, FFIType.u8],
      returns: FFIType.ptr,
    },
    uipc_close: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    uipc_unlink: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    uipc_send: {
      args: [
        FFIType.ptr,
        FFIType.u8,
        FFIType.u64,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u32,
      ],
      returns: FFIType.i32,
    },
    uipc_poll: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    uipc_stats: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.void,
    },
    uipc_max_payload: {
      args: [],
      returns: FFIType.u32,
    },
  });
}

// Header layout (32 bytes, LE): magic u8, version u8, flags u16, payload_len u32,
// msg_id u64, correlation_id u64, msg_type u8, sender_pid u32, _pad[3].
const HEADER_SIZE = 32;

function parseHeader(view: DataView) {
  return {
    magic: view.getUint8(0),
    version: view.getUint8(1),
    payloadLen: view.getUint32(4, true),
    msgId: view.getBigUint64(8, true),
    correlationId: view.getBigUint64(16, true),
    msgType: view.getUint8(24),
    senderPid: view.getUint32(25, true),
  };
}

export class UIPCRing {
  readonly #lib: ReturnType<typeof loadLib>;
  readonly #ring: number; // opaque pointer
  readonly #maxPayload: number;
  #msgId: bigint = 1n;

  // Pre-allocated poll() buffers — zero heap alloc on the hot path.
  readonly #headerBuf: ArrayBuffer;
  readonly #payloadBuf: ArrayBuffer;
  readonly #lenBuf: ArrayBuffer;

  constructor(name: string, create: boolean) {
    this.#lib = loadLib();
    this.#maxPayload = this.#lib.symbols.uipc_max_payload();

    const nameBytes = Buffer.from(name + "\0");
    const ringPtr = this.#lib.symbols.uipc_open(ptr(nameBytes), create ? 1 : 0);
    if (!ringPtr) throw new Error(`Failed to open ring '${name}'`);
    this.#ring = ringPtr;

    this.#headerBuf = new ArrayBuffer(HEADER_SIZE);
    this.#payloadBuf = new ArrayBuffer(this.#maxPayload);
    this.#lenBuf = new ArrayBuffer(4);
  }

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

  call(payload: Buffer): bigint {
    return this.send(MSG.CALL, payload);
  }

  reply(payload: Buffer, correlationId: bigint): void {
    this.send(MSG.REPLY, payload, correlationId);
  }

  emit(payload: Buffer): void {
    this.send(MSG.EVENT, payload);
  }

  ping(): bigint {
    return this.send(MSG.PING, Buffer.alloc(0));
  }

  /** Non-blocking poll. Null if the ring is empty. Zero heap alloc. */
  poll(): ReceivedMessage | null {
    const hdrPtr = ptr(this.#headerBuf);
    const payPtr = ptr(this.#payloadBuf);
    const lenPtr = ptr(this.#lenBuf);

    const rc = this.#lib.symbols.uipc_poll(this.#ring, hdrPtr, payPtr, lenPtr);

    if (rc === 0) return null;
    if (rc === -1) throw new Error("Ring error or CRC mismatch");

    const hdrView = new DataView(this.#headerBuf);
    const lenView = new DataView(this.#lenBuf);
    const hdr = parseHeader(hdrView);
    const payLen = lenView.getUint32(0, true);

    // Slice the payload without copying (share the underlying ArrayBuffer).
    const payloadSlice = Buffer.from(this.#payloadBuf, 0, payLen);
    // Make a real copy so the caller owns the memory.
    const payload = Buffer.from(payloadSlice);

    return {
      msgType: hdr.msgType,
      msgId: hdr.msgId,
      correlationId: hdr.correlationId,
      senderPid: hdr.senderPid,
      payload,
    };
  }

  drain(): ReceivedMessage[] {
    const msgs: ReceivedMessage[] = [];
    let msg: ReceivedMessage | null;
    while ((msg = this.poll()) !== null) msgs.push(msg);
    return msgs;
  }

  /** Spin-wait for a REPLY. Use in a Worker, not the main thread. */
  waitForReply(correlationId: bigint, timeoutMs = 5000): ReceivedMessage {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = this.poll();
      if (
        msg &&
        msg.correlationId === correlationId &&
        msg.msgType === MSG.REPLY
      ) {
        return msg;
      }
    }
    throw new Error(
      `Timeout waiting for reply to correlationId=${correlationId}`,
    );
  }

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

  get maxPayloadSize(): number {
    return this.#maxPayload;
  }

  /** Unlink the shm segment. Call once, from the process that created it. */
  unlink(): void {
    this.#lib.symbols.uipc_unlink(this.#ring);
  }

  close(): void {
    this.#lib.symbols.uipc_close(this.#ring);
    this.#lib.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

export function createRing(name = "/uipc_bridge_v1"): UIPCRing {
  return new UIPCRing(name, true);
}

export function connectRing(name = "/uipc_bridge_v1"): UIPCRing {
  return new UIPCRing(name, false);
}
