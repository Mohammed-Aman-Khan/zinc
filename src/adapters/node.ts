/**
 * src/adapters/node.ts — Node.js adapter for the Rust N-API addon.
 *
 * UIPCRingHandle.send() returns void, but RingLike.send() must return bigint
 * so the RPC layer can correlate replies. We use sendCall() for MSG_CALL
 * (which returns the id) and return 0n for everything else (safe — callers ignore it).
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import type { RingLike } from "../../protocol/rpc.ts";
import type { SharedMemoryRegion } from "../types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Packaged: zinc/native/zinc.node. Dev: node-addon/target/release/.
function loadAddon() {
  const nativeDir =
    process.env.ZINC_NATIVE_DIR ??
    join(__dirname, "../../node-addon/target/release");
  const require = createRequire(import.meta.url);
  try {
    return require(join(nativeDir, "uipc_node.node"));
  } catch {
    throw new Error(
      `Zinc: could not load native addon from "${nativeDir}". ` +
        `Run "npm run build" first, or set ZINC_NATIVE_DIR to override.`,
    );
  }
}

const MSG_CALL = 0x01;

interface NativeHandle {
  sendCall(buf: Buffer): bigint;
  send(msgType: number, buf: Buffer, correlationId?: bigint): void;
  poll(): {
    msgType: number;
    msgId: bigint;
    correlationId: bigint;
    payload: Uint8Array;
  } | null;
  stats(): { used: bigint; free: bigint };
  unlink(): void;
  close(): void;
  constructor: { maxPayloadSize?: () => number };
}

export class NodeRingAdapter implements RingLike {
  readonly #handle: NativeHandle;

  constructor(name: string, create: boolean) {
    const addon = loadAddon();
    this.#handle = new addon.UIPCRingHandle(name, create);
  }

  send(msgType: number, payload: Uint8Array, correlationId?: bigint): bigint {
    const buf = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    if (msgType === MSG_CALL) return this.#handle.sendCall(buf) as bigint;
    this.#handle.send(msgType, buf, correlationId);
    return 0n;
  }

  poll(): {
    msgType: number;
    msgId: bigint;
    correlationId: bigint;
    payload: Uint8Array;
  } | null {
    return this.#handle.poll() as ReturnType<NodeRingAdapter["poll"]>;
  }

  get maxPayloadSize(): number {
    // The N-API addon exposes this as a static; fall back to the wire-level cap.
    return (
      (
        this.#handle.constructor as { maxPayloadSize?: () => number }
      ).maxPayloadSize?.() ?? 4064
    );
  }

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

// ── Shared Buffer (Node.js) ───────────────────────────────────────────────

interface NativeSharedBufferHandle {
  buffer(): ArrayBuffer;
  byteLength: number;
  unlink(): void;
  close(): void;
}

export class NodeSharedBuffer implements SharedMemoryRegion {
  readonly buffer: ArrayBuffer;
  readonly byteLength: number;
  readonly #handle: NativeSharedBufferHandle;

  private constructor(handle: NativeSharedBufferHandle) {
    this.#handle = handle;
    this.buffer = handle.buffer();
    this.byteLength = handle.byteLength;
  }

  static create(name: string, size: number): NodeSharedBuffer {
    const addon = loadAddon();
    const handle = addon.SharedBufferHandle.create(name, size);
    return new NodeSharedBuffer(handle);
  }

  static open(name: string, size: number): NodeSharedBuffer {
    const addon = loadAddon();
    const handle = addon.SharedBufferHandle.open(name, size);
    return new NodeSharedBuffer(handle);
  }

  unlink(): void {
    this.#handle.unlink();
  }

  close(): void {
    this.#handle.close();
  }
}
