/**
 * Zinc — cross-runtime IPC over a lock-free shared-memory ring buffer.
 * Most users need only `serve` and `connect`; everything else is escape hatches.
 *
 * @example
 * const server = await serve('my-service')
 * server.handle('greet', ({ name }) => `Hello, ${name}!`)
 *
 * const client = await connect('my-service')
 * await client.call('greet', { name: 'World' }) // 'Hello, World!'
 */

export { serve, connect } from "./channel.ts";
export { detectRuntime } from "./runtime.ts";

export type {
  ZincServer,
  ZincClient,
  Handler,
  ServeOptions,
  ConnectOptions,
  ZincRuntime,
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
