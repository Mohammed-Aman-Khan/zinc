/**
 * protocol/rpc.ts
 * CALL/REPLY correlation over the ring buffer.
 *
 *   caller → CALL { method, ...args }
 *   callee → REPLY { result } | { error }
 *   caller ← matched by correlationId
 *
 * Both sides can share one ring (MPSC-like), or use two separate rings
 * (one per direction) — pass `recvRing` to the constructor to opt in.
 */

import { encodeAuto, decodeAuto } from "./flat_msg.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export type Handler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

export interface RPCPeer {
  /** Send a CALL and await the REPLY. Throws on timeout or remote error. */
  call(
    method: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;

  /** Register a handler for incoming CALLs. */
  register(method: string, handler: Handler): void;

  /** Start the receive loop (runs until stop() is called). */
  start(): void;

  /** Gracefully stop the receive loop. */
  stop(): void;
}

// Transport-agnostic ring interface. Node's Buffer extends Uint8Array, so
// Uint8Array covers all runtimes without pulling in node types here.
export interface RingLike {
  send(msgType: number, payload: Uint8Array, correlationId?: bigint): bigint;
  poll(): {
    msgType: number;
    msgId: bigint;
    correlationId: bigint;
    payload: Uint8Array;
  } | null;
  readonly maxPayloadSize: number;
}

// ── RPCNode ────────────────────────────────────────────────────────────────

export class RPCNode implements RPCPeer {
  readonly #sendRing: RingLike; // Ring to write outgoing CALLs/events
  readonly #recvRing: RingLike; // Ring to read replies/incoming calls
  readonly #handlers: Map<string, Handler> = new Map();
  readonly #pending: Map<
    bigint,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  > = new Map();
  #running = false;
  #pollTimer: ReturnType<typeof setInterval> | null = null;

  // Msg type constants (must match MSG in ring adapters).
  static readonly MSG_CALL = 0x01;
  static readonly MSG_REPLY = 0x02;
  static readonly MSG_EVENT = 0x03;
  static readonly MSG_ERROR = 0xff;

  // sendRing carries outbound CALLs/events; recvRing carries inbound replies/calls.
  // Omit recvRing to use one ring for both directions (fine for simple cases).
  constructor(sendRing: RingLike, recvRing?: RingLike) {
    this.#sendRing = sendRing;
    this.#recvRing = recvRing ?? sendRing;
  }

  // ── Producer ──────────────────────────────────────────────────────────

  call(
    method: string,
    args: Record<string, unknown> = {},
    timeoutMs = 5000,
  ): Promise<unknown> {
    const payload = encodeAuto({ method, ...args });
    const msgId = this.#sendRing.send(RPCNode.MSG_CALL, payload);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(msgId);
        reject(new Error(`RPC timeout: method='${method}' msgId=${msgId}`));
      }, timeoutMs);

      this.#pending.set(msgId, { resolve, reject, timer });
    });
  }

  emit(event: string, data: Record<string, unknown> = {}): void {
    const payload = encodeAuto({ event, ...data });
    this.#sendRing.send(RPCNode.MSG_EVENT, payload);
  }

  // ── Consumer ──────────────────────────────────────────────────────────

  register(method: string, handler: Handler): void {
    this.#handlers.set(method, handler);
  }

  start(pollIntervalMs = 1): void {
    this.#running = true;
    this.#pollTimer = setInterval(() => this.#tick(), pollIntervalMs);
  }

  stop(): void {
    this.#running = false;
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    // Reject all pending calls.
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(
        new Error(`RPCNode stopped while awaiting reply to msgId=${id}`),
      );
    }
    this.#pending.clear();
  }

  #tick(): void {
    if (!this.#running) return;

    let msg;
    while ((msg = this.#recvRing.poll()) !== null) {
      // Node's Buffer extends Uint8Array — no conversion needed.
      const payload = msg.payload;
      switch (msg.msgType) {
        case RPCNode.MSG_CALL:
          this.#handleCall(msg.msgId, payload);
          break;
        case RPCNode.MSG_REPLY:
          this.#handleReply(msg.correlationId, payload);
          break;
        case RPCNode.MSG_EVENT:
          this.#handleEvent(payload);
          break;
      }
    }
  }

  async #handleCall(msgId: bigint, payload: Uint8Array): Promise<void> {
    let result: unknown;
    let isError = false;

    try {
      const args = decodeAuto(payload);
      const method = args.method as string;
      const handler = this.#handlers.get(method);
      if (!handler) throw new Error(`Unknown RPC method: '${method}'`);

      const { method: _, ...rest } = args;
      result = await handler(rest);
    } catch (err: unknown) {
      isError = true;
      result = err instanceof Error ? err.message : String(err);
    }

    // Send REPLY.
    const replyPayload = encodeAuto(
      isError ? { error: result as string } : { result: result ?? null },
    );

    try {
      this.#sendRing.send(RPCNode.MSG_REPLY, replyPayload, msgId);
    } catch {
      // Ring full — caller will time out.
    }
  }

  #handleReply(correlationId: bigint, payload: Uint8Array): void {
    const pending = this.#pending.get(correlationId);
    if (!pending) return; // Stale or unsolicited reply.

    clearTimeout(pending.timer);
    this.#pending.delete(correlationId);

    const obj = decodeAuto(payload);
    if ("error" in obj) {
      pending.reject(new Error(obj.error as string));
    } else {
      pending.resolve(obj.result);
    }
  }

  #handleEvent(payload: Uint8Array): void {
    try {
      const obj = decodeAuto(payload);
      const event = obj.event as string;
      const handler = this.#handlers.get(`event:${event}`);
      if (handler) {
        const { event: _, ...rest } = obj;
        void handler(rest);
      }
    } catch {
      /* ignore malformed events */
    }
  }

  onEvent(event: string, handler: Handler): void {
    this.#handlers.set(`event:${event}`, handler);
  }
}
