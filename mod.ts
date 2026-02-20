/**
 * deno-plugin/mod.ts
 * Universal-IPC Bridge — Deno runtime adapter.
 *
 * Uses Deno.dlopen (--unstable-ffi) to call the Zig shared library.
 * Permission required: --allow-ffi --allow-read
 */

// ── FFI symbols ────────────────────────────────────────────────────────────

const HEADER_SIZE = 32;

function getLibPath(): string {
  const override = Deno.env.get("UIPC_LIB_DIR");
  const base     = override ?? new URL("../core/zig-out/lib", import.meta.url).pathname;
  const suffix   = Deno.build.os === "darwin" ? "dylib" : "so";
  return `${base}/libuipc_core.${suffix}`;
}

const lib = Deno.dlopen(getLibPath(), {
  uipc_open:        { parameters: ["buffer", "u8"],                                       result: "pointer" },
  uipc_close:       { parameters: ["pointer"],                                             result: "void" },
  uipc_unlink:      { parameters: ["pointer"],                                             result: "void" },
  uipc_send:        { parameters: ["pointer", "u8", "u64", "u64", "buffer", "u32"],       result: "i32" },
  uipc_poll:        { parameters: ["pointer", "buffer", "buffer", "buffer"],               result: "i32" },
  uipc_stats:       { parameters: ["pointer", "buffer", "buffer"],                         result: "void" },
  uipc_max_payload: { parameters: [],                                                       result: "u32" },
} as const);

// ── Types ──────────────────────────────────────────────────────────────────

export const MSG = {
  CALL:  0x01 as const,
  REPLY: 0x02 as const,
  EVENT: 0x03 as const,
  PING:  0x04 as const,
  PONG:  0x05 as const,
  ERROR: 0xFF as const,
};

export interface ReceivedMessage {
  msgType:       number;
  msgId:         bigint;
  correlationId: bigint;
  senderPid:     number;
  payload:       Uint8Array;
}

// ── Header parser ──────────────────────────────────────────────────────────

function parseHeader(buf: ArrayBuffer) {
  const v = new DataView(buf);
  return {
    magic:         v.getUint8(0),
    version:       v.getUint8(1),
    payloadLen:    v.getUint32(4, true),
    msgId:         v.getBigUint64(8, true),
    correlationId: v.getBigUint64(16, true),
    msgType:       v.getUint8(24),
    senderPid:     v.getUint16(25, true),
  };
}

// ── UIPCRing class ─────────────────────────────────────────────────────────

export class UIPCRing {
  readonly #ring:       Deno.PointerValue;
  readonly #maxPayload: number;
  #msgId:               bigint = 1n;

  readonly #headerBuf:  ArrayBuffer;
  readonly #payloadBuf: ArrayBuffer;
  readonly #lenBuf:     ArrayBuffer;

  constructor(name: string, create: boolean) {
    this.#maxPayload = lib.symbols.uipc_max_payload();

    const enc      = new TextEncoder();
    const nameBuf  = enc.encode(name + "\0");

    const ring = lib.symbols.uipc_open(nameBuf, create ? 1 : 0);
    if (ring === null) throw new Error(`Failed to open ring '${name}'`);
    this.#ring = ring;

    this.#headerBuf  = new ArrayBuffer(HEADER_SIZE);
    this.#payloadBuf = new ArrayBuffer(this.#maxPayload);
    this.#lenBuf     = new ArrayBuffer(4);
  }

  // ── Producer ──────────────────────────────────────────────────────────

  send(msgType: number, payload: Uint8Array, correlationId = 0n): bigint {
    const id = this.#msgId++;
    const rc = lib.symbols.uipc_send(
      this.#ring,
      msgType,
      id,
      correlationId,
      payload,
      payload.byteLength,
    );
    if (rc !== 0) throw new Error("Ring full or uipc_send failed");
    return id;
  }

  call(payload: Uint8Array): bigint      { return this.send(MSG.CALL, payload); }
  reply(payload: Uint8Array, id: bigint) { this.send(MSG.REPLY, payload, id); }
  emit(payload: Uint8Array)              { this.send(MSG.EVENT, payload); }
  ping(): bigint                         { return this.send(MSG.PING, new Uint8Array(0)); }

  // ── Consumer ──────────────────────────────────────────────────────────

  poll(): ReceivedMessage | null {
    const hdrBuf = new Uint8Array(this.#headerBuf);
    const payBuf = new Uint8Array(this.#payloadBuf);
    const lenBuf = new Uint8Array(this.#lenBuf);

    const rc = lib.symbols.uipc_poll(this.#ring, hdrBuf, payBuf, lenBuf);

    if (rc === 0)  return null;
    if (rc === -1) throw new Error("Ring error or CRC mismatch");

    const hdr    = parseHeader(this.#headerBuf);
    const lenView = new DataView(this.#lenBuf);
    const payLen = lenView.getUint32(0, true);
    const payload = new Uint8Array(this.#payloadBuf, 0, payLen).slice(); // copy

    return {
      msgType:       hdr.msgType,
      msgId:         hdr.msgId,
      correlationId: hdr.correlationId,
      senderPid:     hdr.senderPid,
      payload,
    };
  }

  drain(): ReceivedMessage[] {
    const msgs: ReceivedMessage[] = [];
    let msg: ReceivedMessage | null;
    while ((msg = this.poll()) !== null) msgs.push(msg);
    return msgs;
  }

  waitForReply(correlationId: bigint, timeoutMs = 5000): ReceivedMessage {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = this.poll();
      if (msg && msg.correlationId === correlationId && msg.msgType === MSG.REPLY) {
        return msg;
      }
    }
    throw new Error(`Timeout: no reply for correlationId=${correlationId}`);
  }

  // ── Utilities ──────────────────────────────────────────────────────────

  stats(): { used: bigint; free: bigint } {
    const usedBuf = new Uint8Array(8);
    const freeBuf = new Uint8Array(8);
    lib.symbols.uipc_stats(this.#ring, usedBuf, freeBuf);
    const u = new DataView(usedBuf.buffer);
    const f = new DataView(freeBuf.buffer);
    return { used: u.getBigUint64(0, true), free: f.getBigUint64(0, true) };
  }

  get maxPayloadSize() { return this.#maxPayload; }

  unlink() { lib.symbols.uipc_unlink(this.#ring); }

  close() {
    lib.symbols.uipc_close(this.#ring);
    lib.close();
  }

  [Symbol.dispose]() { this.close(); }
}

export function createRing(name = "/uipc_bridge_v1")  { return new UIPCRing(name, true); }
export function connectRing(name = "/uipc_bridge_v1") { return new UIPCRing(name, false); }
