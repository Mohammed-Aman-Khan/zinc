export interface SecurityPolicy {
  maxPayloadBytes?: number;

  allowedPids?: Set<number>;

  maxMsgPerSecPerPid?: number;

  allowedMsgTypes?: Set<number>;

  allowedMethods?: Set<string>;

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

  readonly #seenIds: Map<number, bigint> = new Map();

  readonly #buckets: Map<number, number> = new Map();
  readonly #lastRefill: Map<number, number> = new Map();

  constructor(policy: SecurityPolicy = {}) {
    this.#policy = {
      maxPayloadBytes: policy.maxPayloadBytes ?? 4064,
      allowedPids: policy.allowedPids ?? new Set(),
      maxMsgPerSecPerPid: policy.maxMsgPerSecPerPid ?? 100_000,
      allowedMsgTypes: policy.allowedMsgTypes ?? DEFAULT_ALLOWED_TYPES,
      allowedMethods: policy.allowedMethods ?? new Set(),
      replayProtection: policy.replayProtection ?? true,
    };
  }

  verify(msg: IncomingMsg): SecurityVerdict {
    const payLen = msg.payload.length ?? (msg.payload as Buffer).byteLength;
    if (payLen > this.#policy.maxPayloadBytes) {
      return {
        allowed: false,
        reason: `Payload too large: ${payLen} > ${this.#policy.maxPayloadBytes}`,
      };
    }

    if (!this.#policy.allowedMsgTypes.has(msg.msgType)) {
      return {
        allowed: false,
        reason: `Disallowed msg_type: 0x${msg.msgType.toString(16)}`,
      };
    }

    if (
      this.#policy.allowedPids.size > 0 &&
      !this.#policy.allowedPids.has(msg.senderPid)
    ) {
      return {
        allowed: false,
        reason: `Disallowed sender PID: ${msg.senderPid}`,
      };
    }

    const now = Date.now();
    const pid = msg.senderPid;
    const lastRefill = this.#lastRefill.get(pid) ?? now;
    const elapsed = (now - lastRefill) / 1000;
    let tokens =
      (this.#buckets.get(pid) ?? this.#policy.maxMsgPerSecPerPid) +
      elapsed * this.#policy.maxMsgPerSecPerPid;
    tokens = Math.min(tokens, this.#policy.maxMsgPerSecPerPid);
    if (tokens < 1) {
      return { allowed: false, reason: `Rate limit exceeded for PID ${pid}` };
    }
    this.#buckets.set(pid, tokens - 1);
    this.#lastRefill.set(pid, now);

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

  verifyMethod(methodName: string): SecurityVerdict {
    if (this.#policy.allowedMethods.size === 0) return { allowed: true };
    if (!this.#policy.allowedMethods.has(methodName)) {
      return { allowed: false, reason: `Disallowed method: '${methodName}'` };
    }
    return { allowed: true };
  }

  reset(): void {
    this.#seenIds.clear();
    this.#buckets.clear();
    this.#lastRefill.clear();
  }

  stats(): { trackedPids: number; seenIds: Record<number, bigint> } {
    const seenIds: Record<number, bigint> = {};
    for (const [pid, id] of this.#seenIds) seenIds[pid] = id;
    return { trackedPids: this.#seenIds.size, seenIds };
  }
}

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
