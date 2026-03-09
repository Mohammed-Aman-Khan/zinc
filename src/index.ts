/**
 * Zinc — Universal IPC Bridge for JS Runtimes
 *
 * The single entry point for the Zinc package.
 *
 * High-level API (use this 99% of the time):
 *
 *   import { serve, connect, detectRuntime } from 'zinc'
 *
 *   // Server — any runtime
 *   const server = await serve('my-service')
 *   server.handle('greet', ({ name }) => `Hello, ${name}!`)
 *
 *   // Client — any runtime (even a different one on the same machine)
 *   const client = await connect('my-service')
 *   const msg = await client.call('greet', { name: 'World' })
 *
 * Low-level / advanced exports are also available for power users who need
 * direct access to the ring buffer, protocol layer, or security primitives.
 */

// ── High-level API ────────────────────────────────────────────────────────────

export { serve, connect } from "./channel.ts";
export { detectRuntime } from "./runtime.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type {
  ZincServer,
  ZincClient,
  Handler,
  ServeOptions,
  ConnectOptions,
  ZincRuntime,
} from "./types.ts";

// ── Low-level / advanced API ──────────────────────────────────────────────────
//
// These exports give power users direct access to the internals.
// Most applications should not need them.

/** Direct ring-buffer + RPC layer (runtime-agnostic). */
export { RPCNode } from "../protocol/rpc.ts";
export type { RingLike, RPCPeer } from "../protocol/rpc.ts";

/** Binary serialization primitives. */
export {
  encode,
  decode,
  encodeAuto,
  decodeAuto,
  v,
} from "../protocol/flat_msg.ts";
export type { FlatMsg, FlatValue } from "../protocol/flat_msg.ts";

/** Security / rate-limiting layer. */
export { SecurityGuard, secureFilter } from "../protocol/security.ts";
export type {
  SecurityPolicy,
  IncomingMsg,
  SecurityVerdict,
} from "../protocol/security.ts";

/** Connection pool for multi-worker topologies. */
export { RingPool } from "../protocol/pool.ts";
export type {
  ChannelConfig,
  ChannelStats,
  RingFactory,
} from "../protocol/pool.ts";

/** Runtime-specific ring adapter (direct native access). */
export { openRing } from "./runtime.ts";
