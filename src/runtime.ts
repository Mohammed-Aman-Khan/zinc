/**
 * src/runtime.ts
 * Zinc — Universal IPC Bridge for JS Runtimes
 *
 * Runtime detection and native ring-buffer adapter loading.
 * Each runtime gets the right native binding automatically —
 * no manual configuration required.
 */

import type { ZincRuntime } from "./types.ts";
import type { RingLike } from "../protocol/rpc.ts";

// ── Runtime detection ─────────────────────────────────────────────────────────

declare const Bun: unknown;
declare const Deno: unknown;

/**
 * Detect which JS runtime is currently executing.
 *
 * Detection order: Bun → Deno → Node.js (fallback).
 * Works across all three runtimes without external dependencies.
 */
export function detectRuntime(): ZincRuntime {
  if (typeof Bun !== "undefined") return "bun";
  if (typeof Deno !== "undefined") return "deno";
  return "node";
}

// ── Ring factory ──────────────────────────────────────────────────────────────

/**
 * Open a native ring buffer appropriate for the current runtime.
 *
 * @param name    POSIX shm name, e.g. "/my-service"
 * @param create  true = server (creates the ring), false = client (attaches)
 *
 * Uses dynamic imports so each runtime adapter is only loaded when actually
 * needed — no Bun/Deno/Node modules are bundled into the wrong runtime.
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
