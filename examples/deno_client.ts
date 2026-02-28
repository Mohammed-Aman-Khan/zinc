/**
 * demo/deno_client.ts
 * Deno client connecting to the Bun-created ring.
 *
 * Run (after bun_server.ts is running):
 *   deno run --allow-ffi --allow-env demo/deno_client.ts
 */

import { connectRing, MSG } from "../deno-plugin/mod.ts";
import {
  encode,
  decode,
  encodeAuto,
  decodeAuto,
  v,
} from "../protocol/flat_msg.ts";

const RING_NAME = "/uipc_demo_ring";

console.log("🦕 Universal-IPC Bridge — Deno Client");
console.log(`   Ring: ${RING_NAME}\n`);

const ring = connectRing(RING_NAME);

// ── Tiny inline RPC client ────────────────────────────────────────────────

let msgIdCounter = 1n;

async function call(
  method: string,
  args: Record<string, unknown> = {},
  timeoutMs = 5000,
): Promise<unknown> {
  const payload = encodeAuto({ method, ...args });
  const msgId = ring.send(MSG.CALL, payload);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = ring.poll();
    if (msg && msg.msgType === MSG.REPLY && msg.correlationId === msgId) {
      const obj = decodeAuto(msg.payload);
      if ("error" in obj) throw new Error(obj.error as string);
      return obj.result;
    }
    await new Promise((r) => setTimeout(r, 0)); // yield
  }
  throw new Error(`RPC timeout: ${method}`);
}

// ── Main ─────────────────────────────────────────────────────────────────

console.log("📡 Calling bun_server from Deno...\n");

const pong = await call("ping");
console.log(`  ping → ${pong}`);

const sum = await call("add", { a: 7, b: 35 });
console.log(`  add(7, 35) → ${sum}`);

const echo = await call("echo", { message: "Hello from Deno!" });
console.log(`  echo → "${echo}"`);

const fib = await call("fibonacci", { n: 15 });
console.log(`  fibonacci(15) → ${fib}`);

// Throughput test.
console.log("\n  ⚡ Throughput test (500 sequential calls)...");
const t0 = performance.now();
const N = 500;
for (let i = 0; i < N; i++) {
  await call("add", { a: i, b: i * 2 });
}
const elapsed = performance.now() - t0;
console.log(`     ${N} sequential calls in ${elapsed.toFixed(1)}ms`);
console.log(`     = ${(N / (elapsed / 1000)).toFixed(0)} calls/sec`);

console.log("\n✅ Deno client done.\n");

ring.close();
