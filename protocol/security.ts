/**
 * protocol/security.ts
 * Security hardening layer for Universal-IPC Bridge.
 *
 * Sits between the ring buffer consumer and the RPC dispatcher.
 * Enforces:
 *   1. Monotonic sequence numbers (replay protection)
 *   2. PID allowlist (origin verification)
 *   3. Rate limiting per PID (DoS protection)
 *   4. Payload size hard cap (overflow protection)
 *   5. Message type allowlist
 *   6. Method name allowlist (optional, for production lockdown)
 */

export interface SecurityPolicy {
  /** Maximum payload bytes (default: 4064 = MAX_PAYLOAD). */
  maxPayloadBytes?: number;

  /**
   * If set, only these PIDs may send to this node.
   * A value of 0 means "any PID" (loophole for when PIDs aren't available).
   */
  allowedPids?: Set<number>;

  /**
   * Maximum messages per second from a single PID before rate-limiting kicks in.
   * Default: 100_000 (effectively unlimited for benchmark usage).
   */
  maxMsgPerSecPerPid?: number;

  /**
   * If set, only these msg_types are accepted.
   * Default: CALL, REPLY, EVENT, PING, PONG.
   */
  allowedMsgTypes?: Set<number>;

  /**
   * If set, only these RPC method names are dispatched.
   * All others are silently dropped.
   */
  allowedMethods?: Set<string>;

  /**
   * If true, replay-detect using monotonic msgId per sender PID.
   * Default: true.
   */
  replayProtection?: boolean;
}

export interface IncomingMsg {
  msgType: number;
  msgId: bigint;
  correlationId: bigint;
  senderPid: number;
  payload: Uint8Array | Buffer;
}

export interface SecurityVerdict {
  allowed: boolean;
  reason?: string;
}

const DEFAULT_ALLOWED_TYPES = new Set([0x01, 0x02, 0x03, 0x04, 0x05]);
const DEC = new TextDecoder();

export class SecurityGuard {
  readonly #policy: Required<SecurityPolicy>;
  /** Last seen msgId per PID — for monotonicity check. */
  readonly #seenIds: Map<number, bigint> = new Map();
  /** Token bucket: tokens per PID (refills each second). */
  readonly #buckets: Map<number, number> = new Map();
  readonly #lastRefill: Map<number, number> = new Map();

  constructor(policy: SecurityPolicy = {}) {
    this.#policy = {
      maxPayloadBytes: policy.maxPayloadBytes ?? 4064,
      allowedPids: policy.allowedPids ?? new Set(), // empty = any
      maxMsgPerSecPerPid: policy.maxMsgPerSecPerPid ?? 100_000,
      allowedMsgTypes: policy.allowedMsgTypes ?? DEFAULT_ALLOWED_TYPES,
      allowedMethods: policy.allowedMethods ?? new Set(), // empty = any
      replayProtection: policy.replayProtection ?? true,
    };
  }

  verify(msg: IncomingMsg): SecurityVerdict {
    // 1. Payload size
    const payLen = msg.payload.length ?? (msg.payload as Buffer).byteLength;
    if (payLen > this.#policy.maxPayloadBytes) {
      return {
        allowed: false,
        reason: `Payload too large: ${payLen} > ${this.#policy.maxPayloadBytes}`,
      };
    }

    // 2. Message type allowlist
    if (!this.#policy.allowedMsgTypes.has(msg.msgType)) {
      return {
        allowed: false,
        reason: `Disallowed msg_type: 0x${msg.msgType.toString(16)}`,
      };
    }

    // 3. PID allowlist (skip if set is empty)
    if (
      this.#policy.allowedPids.size > 0 &&
      !this.#policy.allowedPids.has(msg.senderPid)
    ) {
      return {
        allowed: false,
        reason: `Disallowed sender PID: ${msg.senderPid}`,
      };
    }

    // 4. Rate limiting (token bucket)
    const now = Date.now();
    const pid = msg.senderPid;
    const lastRefill = this.#lastRefill.get(pid) ?? now;
    const elapsed = (now - lastRefill) / 1000; // seconds
    let tokens =
      (this.#buckets.get(pid) ?? this.#policy.maxMsgPerSecPerPid) +
      elapsed * this.#policy.maxMsgPerSecPerPid;
    tokens = Math.min(tokens, this.#policy.maxMsgPerSecPerPid);
    if (tokens < 1) {
      return { allowed: false, reason: `Rate limit exceeded for PID ${pid}` };
    }
    this.#buckets.set(pid, tokens - 1);
    this.#lastRefill.set(pid, now);

    // 5. Replay protection (monotonic msgId per PID)
    if (this.#policy.replayProtection && msg.senderPid !== 0) {
      const lastId = this.#seenIds.get(pid) ?? 0n;
      if (msg.msgId <= lastId) {
        return {
          allowed: false,
          reason: `Replay detected: msgId ${msg.msgId} <= last ${lastId} from PID ${pid}`,
        };
      }
      this.#seenIds.set(pid, msg.msgId);
    }

    return { allowed: true };
  }

  /**
   * Verify method name against allowlist.
   * Call this after decoding the payload, only for CALL messages.
   */
  verifyMethod(methodName: string): SecurityVerdict {
    if (this.#policy.allowedMethods.size === 0) return { allowed: true };
    if (!this.#policy.allowedMethods.has(methodName)) {
      return { allowed: false, reason: `Disallowed method: '${methodName}'` };
    }
    return { allowed: true };
  }

  /** Reset state (e.g., between test runs). */
  reset(): void {
    this.#seenIds.clear();
    this.#buckets.clear();
    this.#lastRefill.clear();
  }

  /** Export current stats for monitoring. */
  stats(): { trackedPids: number; seenIds: Record<number, bigint> } {
    const seenIds: Record<number, bigint> = {};
    for (const [pid, id] of this.#seenIds) seenIds[pid] = id;
    return { trackedPids: this.#seenIds.size, seenIds };
  }
}

// ── Convenience: wrap a ring poll with security checks ─────────────────────

export type SecureRecvResult =
  | { ok: true; msg: IncomingMsg }
  | { ok: false; reason: string };

export function secureFilter(
  msg: IncomingMsg | null,
  guard: SecurityGuard,
): SecureRecvResult | null {
  if (msg === null) return null;

  const verdict = guard.verify(msg);
  if (!verdict.allowed) {
    return { ok: false, reason: verdict.reason! };
  }
  return { ok: true, msg };
}
