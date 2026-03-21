/** src/runtime.ts — detect the current JS runtime and load the right native adapter. */

import type { ZincRuntime, SharedMemoryRegion } from "./types.ts";
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

/**
 * Create or open a cross-process shared memory region.
 * Returns an object whose `.buffer` is an ArrayBuffer backed by mmap'd
 * shared memory — both processes see the same physical pages, zero copies.
 *
 * Use TypedArray views (Float32Array, Uint8Array, Int32Array) over the buffer
 * for structured data, and Atomics for synchronization.
 *
 * @param name  POSIX shm name (e.g. "/my-region"). Auto-prefixed if bare.
 * @param size  Size in bytes. Required when creating, must match when opening.
 * @param create  If true, creates the region. If false, opens an existing one.
 */
export async function openSharedBuffer(
  name: string,
  size: number,
  create: boolean,
): Promise<SharedMemoryRegion> {
  const runtime = detectRuntime();

  if (runtime === "bun") {
    const { SharedBuffer } = await import("../bun-ffi/index.ts");
    return create
      ? SharedBuffer.create(name, size)
      : SharedBuffer.open(name, size);
  }

  if (runtime === "deno") {
    const { SharedBuffer } = await import("../deno-plugin/mod.ts");
    return create
      ? SharedBuffer.create(name, size)
      : SharedBuffer.open(name, size);
  }

  // Node.js
  const { NodeSharedBuffer } = await import("./adapters/node.ts");
  return create
    ? NodeSharedBuffer.create(name, size)
    : NodeSharedBuffer.open(name, size);
}
