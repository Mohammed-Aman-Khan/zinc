/**
 * examples/quickstart/client.ts
 * Zinc — Universal IPC Bridge for JS Runtimes
 *
 * Quickstart: a minimal Zinc client.
 *
 * Run with ANY of (server must be running first):
 *   bun  run examples/quickstart/client.ts
 *   node --import tsx/esm examples/quickstart/client.ts
 *   deno run --allow-ffi --allow-env examples/quickstart/client.ts
 */

import { connect, detectRuntime } from "../../src/index.ts";

const runtime = detectRuntime();
const runtimeEmoji: Record<string, string> = {
  bun: "🍞",
  node: "🟢",
  deno: "🦕",
};

console.log(
  `${runtimeEmoji[runtime] ?? ""} Zinc — Quickstart Client (${runtime})\n`,
);

// One line to connect — runtime is detected automatically.
const client = await connect("my-service");

try {
  // ── Basic calls ─────────────────────────────────────────────────────────

  const pong = await client.call("ping");
  console.log(`  ping        → ${pong}`);

  const sum = await client.call("add", { a: 40, b: 2 });
  console.log(`  add(40, 2)  → ${sum}`);

  const echo = await client.call("echo", { message: `Hello from ${runtime}!` });
  console.log(`  echo        → "${echo}"`);

  // ── Async handler ────────────────────────────────────────────────────────

  const delayed = await client.call("delay", { ms: 50 });
  console.log(`  delay(50)   → "${delayed}"`);

  // ── Fire-and-forget event ────────────────────────────────────────────────

  client.emit("log", { level: "info", message: `Event from ${runtime}` });
  console.log(`  emit log    ✓ (fire-and-forget)`);

  // ── Throughput test ──────────────────────────────────────────────────────

  const N = 500;
  console.log(`\n   Throughput: ${N} concurrent calls...`);

  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: N }, (_, i) => client.call("add", { a: i, b: i })),
  );
  const ms = performance.now() - t0;

  console.log(`     ${N} calls in ${ms.toFixed(1)}ms`);
  console.log(`     = ${((N / ms) * 1000).toFixed(0)} calls/sec`);

  console.log(`\n Client done.\n`);
} finally {
  client.close();
}
