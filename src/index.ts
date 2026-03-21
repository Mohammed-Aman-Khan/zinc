/**
 * Zinc — cross-process shared memory for JavaScript runtimes.
 *
 * Core primitive: `sharedBuffer()` gives you an ArrayBuffer backed by
 * mmap'd shared memory — zero copies, zero serialization, direct memory access
 * across processes and runtimes (Bun, Deno, Node.js).
 *
 * Legacy RPC: `serve()` and `connect()` still work for message-passing patterns.
 *
 * @example
 * // Process A (producer)
 * const region = await sharedBuffer('/my-data', 1024, true);
 * const view = new Float32Array(region.buffer);
 * view[0] = 42.0;
 *
 * // Process B (consumer) — reads the same physical memory
 * const region = await sharedBuffer('/my-data', 1024, false);
 * const view = new Float32Array(region.buffer);
 * console.log(view[0]); // 42.0
 */

export { serve, connect } from "./channel.ts";
export { detectRuntime } from "./runtime.ts";
export { openSharedBuffer as sharedBuffer } from "./runtime.ts";

export type {
  ZincServer,
  ZincClient,
  Handler,
  ServeOptions,
  ConnectOptions,
  ZincRuntime,
  SharedMemoryRegion,
} from "./types.ts";

// ── Advanced / escape hatches ─────────────────────────────────────────────────
export { RPCNode } from "../protocol/rpc.ts";
export type { RingLike, RPCPeer } from "../protocol/rpc.ts";

export {
  encode,
  decode,
  encodeAuto,
  decodeAuto,
  v,
} from "../protocol/flat_msg.ts";
export type { FlatMsg, FlatValue } from "../protocol/flat_msg.ts";

export { SecurityGuard, secureFilter } from "../protocol/security.ts";
export type {
  SecurityPolicy,
  IncomingMsg,
  SecurityVerdict,
} from "../protocol/security.ts";

export { RingPool } from "../protocol/pool.ts";
export type {
  ChannelConfig,
  ChannelStats,
  RingFactory,
} from "../protocol/pool.ts";

export { openRing } from "./runtime.ts";
