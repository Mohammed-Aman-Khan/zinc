export declare const MSG_CALL:  number;
export declare const MSG_REPLY: number;
export declare const MSG_EVENT: number;
export declare const MSG_PING:  number;
export declare const MSG_PONG:  number;
export declare const MSG_ERROR: number;

export interface ReceivedMessage {
  msgType:       number;
  msgId:         bigint;
  correlationId: bigint;
  senderPid:     number;
  payload:       Buffer;
}

export interface RingStats {
  used: bigint;
  free: bigint;
}

export declare class UIPCRingHandle {
  /**
   * Open or create a POSIX shared memory ring buffer.
   * @param name   shm name, e.g. "/uipc_bridge_v1"
   * @param create true to create+initialize (first process), false to attach
   */
  constructor(name: string, create: boolean);

  // ── Producer ────────────────────────────────────────────────────────────

  /** Send a message. Use MSG_* constants for msgType. */
  send(msgType: number, payload: Buffer, correlationId?: bigint): void;

  /**
   * Send a CALL message. Returns the assigned msgId (bigint)
   * which must be used to correlate the REPLY.
   */
  sendCall(payload: Buffer): bigint;

  /** Fire-and-forget event. */
  emit(payload: Buffer): void;

  // ── Consumer ────────────────────────────────────────────────────────────

  /**
   * Non-blocking poll.
   * Returns a message object if one is available, or null if the ring is empty.
   */
  poll(): ReceivedMessage | null;

  /**
   * Drain all available messages from the ring.
   * Returns an array (possibly empty).
   */
  drain(): ReceivedMessage[];

  /**
   * Async: wait (on a libuv worker thread) for a REPLY whose correlationId
   * matches waitForId. Resolves with the message, or null on timeout.
   */
  waitForReply(waitForId: bigint, timeoutMs: number): Promise<ReceivedMessage | null>;

  // ── Utilities ────────────────────────────────────────────────────────────

  stats(): RingStats;

  /** Unlink the shm segment (call once, from the process that created it). */
  unlink(): void;

  /** Detach this handle and free native memory. */
  close(): void;

  /** Maximum payload size in bytes (read-only, depends on core build). */
  static maxPayloadSize(): number;
}
