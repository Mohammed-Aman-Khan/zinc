/**
 * demo/bun_server.ts
 * Bun process: creates the ring, registers RPC handlers,
 * and serves calls from Node.js and Deno clients.
 *
 * Run:
 *   bun run demo/bun_server.ts
 */

import { createRing } from "../bun-ffi/index.ts";
import { RPCNode }    from "../protocol/rpc.ts";
import { encode, v }  from "../protocol/flat_msg.ts";

const RING_NAME = "/uipc_demo_ring";

console.log("Universal-IPC Bridge — Bun Server");
console.log(`   Ring: ${RING_NAME}\n`);

const ring = createRing(RING_NAME);

// Register cleanup on exit.
process.on("SIGINT",  () => { ring.unlink(); ring.close(); process.exit(0); });
process.on("SIGTERM", () => { ring.unlink(); ring.close(); process.exit(0); });

// Wrap the ring in the RPC layer.
const rpc = new RPCNode(ring as any);

// ── Register handlers ────────────────────────────────────────────────────

rpc.register("ping", () => "pong");

rpc.register("add", ({ a, b }) => {
  const result = (a as number) + (b as number);
  console.log(`  [handler] add(${a}, ${b}) = ${result}`);
  return result;
});

rpc.register("echo", ({ message }) => {
  console.log(`  [handler] echo: ${message}`);
  return message;
});

rpc.register("fibonacci", ({ n }) => {
  const fib = (x: number): number => x <= 1 ? x : fib(x - 1) + fib(x - 2);
  const result = fib(n as number);
  console.log(`  [handler] fibonacci(${n}) = ${result}`);
  return result;
});

rpc.register("stats", () => {
  const s = ring.stats();
  return { used: s.used.toString(), free: s.free.toString() };
});

rpc.register("bulk_sum", ({ values }) => {
  const arr    = values as number[];
  const result = arr.reduce((a, b) => a + b, 0);
  console.log(`  [handler] bulk_sum(${arr.length} items) = ${result}`);
  return result;
});

// ── Listen for events ────────────────────────────────────────────────────

rpc.onEvent("log", ({ level, message }) => {
  console.log(`  [event:log] [${level}] ${message}`);
});

// ── Start polling ────────────────────────────────────────────────────────

rpc.start(0); // poll as fast as possible

console.log("Server ready. Waiting for calls...\n");
console.log("   Stats:", ring.stats());
console.log();

// Keep the process alive.
setInterval(() => {
  const s = ring.stats();
  if (s.used > 0n) {
    console.log(`  [monitor] Ring: used=${s.used} free=${s.free}`);
  }
}, 1000);
