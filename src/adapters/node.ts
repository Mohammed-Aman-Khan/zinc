/**
 * src/adapters/node.ts
 * Zinc — Universal IPC Bridge for JS Runtimes
 *
 * Node.js adapter: wraps the Rust N-API addon (UIPCRingHandle) to satisfy
 * the RingLike interface used by the protocol/rpc.ts RPCNode layer.
 *
 * Why a wrapper?
 *   UIPCRingHandle.send() returns void. RingLike.send() must return bigint
 *   (the assigned msg_id) so the RPC layer can correlate replies to calls.
 *   For MSG_CALL we use sendCall() which does return the id. For all other
 *   message types (REPLY, EVENT, PING…) the caller never uses the return
 *   value, so returning 0n is safe.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { RingLike } from "../../protocol/rpc.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the native addon path.
// In a distributed npm package this would be at `zinc/native/zinc.node`.
// During local development it lives in node-addon/target/release/.
function loadAddon() {
  const nativeDir =
    process.env.ZINC_NATIVE_DIR ??
    join(__dirname, "../../node-addon/target/release");
  const require = createRequire(import.meta.url);
  try {
    return require(join(nativeDir, "uipc_node.node"));
  } catch {
    throw new Error(
      `Zinc: could not load native Node.js addon from "${nativeDir}". ` +
        `Run "npm run build" first, or set ZINC_NATIVE_DIR to override the path.\n` +
        `See https://github.com/your-org/zinc#building for details.`,
    );
  }
}

// Message type constants (must match protocol constants).
const MSG_CALL = 0x01;

/**
 * Adapter that makes UIPCRingHandle satisfy the RingLike contract.
 */
export class NodeRingAdapter implements RingLike {
  readonly #handle: any;

  constructor(name: string, create: boolean) {
    const addon = loadAddon();
    this.#handle = new addon.UIPCRingHandle(name, create);
  }

  // ── RingLike.send ─────────────────────────────────────────────────────────

  /**
   * Send a message.
   * - For CALL messages: delegates to sendCall(), returns the assigned msg_id.
   * - For all other types: delegates to send(), returns 0n (callers ignore it).
   */
  send(
    msgType: number,
    payload: Uint8Array | Buffer,
    correlationId?: bigint,
  ): bigint {
    const buf = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);

    if (msgType === MSG_CALL) {
      // sendCall returns bigint msg_id for correlation.
      return this.#handle.sendCall(buf) as bigint;
    }

    // For REPLY / EVENT / PING — correlationId may be set for replies.
    this.#handle.send(msgType, buf, correlationId);
    return 0n;
  }

  // ── RingLike.poll ─────────────────────────────────────────────────────────

  poll(): {
    msgType: number;
    msgId: bigint;
    correlationId: bigint;
    payload: Buffer;
  } | null {
    return this.#handle.poll() as ReturnType<NodeRingAdapter["poll"]>;
  }

  // ── RingLike.maxPayloadSize ───────────────────────────────────────────────

  get maxPayloadSize(): number {
    return (this.#handle.constructor as any).maxPayloadSize?.() ?? 4064;
  }

  // ── Extras ────────────────────────────────────────────────────────────────

  stats(): { used: bigint; free: bigint } {
    return this.#handle.stats();
  }

  unlink(): void {
    this.#handle.unlink();
  }

  close(): void {
    this.#handle.close();
  }
}
