/** src/runtime.ts — detect the current JS runtime and load the right native adapter. */

import type { ZincRuntime } from "./types.ts";
import type { RingLike } from "../protocol/rpc.ts";

declare const Bun: unknown;
declare const Deno: unknown;

/** Bun → Deno → Node fallback. Simple globals check, no deps. */
export function detectRuntime(): ZincRuntime {
  if (typeof Bun !== "undefined") return "bun";
  if (typeof Deno !== "undefined") return "deno";
  return "node";
}

/**
 * Open the right native ring adapter for the detected runtime.
 * Dynamic imports mean each adapter is only loaded when actually needed.
 */
export async function openRing(
  name: string,
  create: boolean,
): Promise<RingLike> {
  const runtime = detectRuntime();

  if (runtime === "bun") {
    const { UIPCRing } = await import("../bun-ffi/index.ts");
    return new UIPCRing(name, create) as unknown as RingLike;
  }

  if (runtime === "deno") {
    const { UIPCRing } = await import("../deno-plugin/mod.ts");
    return new UIPCRing(name, create) as unknown as RingLike;
  }

  // Node.js — use the Rust N-API addon via a thin compatibility shim.
  const { NodeRingAdapter } = await import("./adapters/node.ts");
  return new NodeRingAdapter(name, create);
}
