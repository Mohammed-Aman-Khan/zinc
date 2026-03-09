/**
 * examples/deno_client.ts
 * Zinc — Universal IPC Bridge for JS Runtimes
 *
 * Demo client (Deno). Connects to the demo server running in any runtime.
 *
 * Run (server must be running first):
 *   deno run --allow-ffi --allow-env examples/deno_client.ts
 *
 * For a simpler quickstart, see examples/quickstart/.
 */

import { connect } from "../src/index.ts";

console.log("🦕 Zinc — Demo Client (Deno)");
console.log("   Channel: demo-channel\n");

const client = await connect("demo-channel");

try {
  console.log(" Calling server from Deno...\n");

  const pong = await client.call("ping");
  console.log(`  ping        → ${pong}`);

  const sum = await client.call("add", { a: 7, b: 35 });
  console.log(`  add(7, 35)  → ${sum}`);

  const echo = await client.call("echo", { message: "Hello from Deno!" });
  console.log(`  echo        → "${echo}"`);

  const fib = await client.call("fibonacci", { n: 15 });
  console.log(`  fibonacci(15) → ${fib}`);

  client.emit("log", { level: "info", message: "Deno client connected!" });
  console.log(`  emit log    ✓`);

  // Throughput test.
  const N = 500;
  console.log(`\n   Throughput: ${N} concurrent calls...`);
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: N }, (_, i) => client.call("add", { a: i, b: i * 2 })),
  );
  const elapsed = performance.now() - t0;
  console.log(`     ${N} calls in ${elapsed.toFixed(1)}ms`);
  console.log(`     = ${((N / elapsed) * 1000).toFixed(0)} calls/sec`);

  console.log("\n Deno client done.\n");
} finally {
  client.close();
}
