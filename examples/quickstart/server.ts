/**
 * examples/quickstart/server.ts
 * Zinc — Universal IPC Bridge for JS Runtimes
 *
 * Quickstart: a minimal Zinc server.
 *
 * Run with ANY of:
 *   bun  run examples/quickstart/server.ts
 *   node --import tsx/esm examples/quickstart/server.ts   (Node + tsx)
 *   deno run --allow-ffi --allow-env examples/quickstart/server.ts
 *
 * Then in another terminal run the matching client:
 *   bun  run examples/quickstart/client.ts
 *   node --import tsx/esm examples/quickstart/client.ts
 *   deno run --allow-ffi --allow-env examples/quickstart/client.ts
 */

import { serve } from "../../src/index.ts";

console.log(" Zinc — Quickstart Server");
console.log("   Channel: my-service\n");

const server = await serve("my-service");

server
  // Simple request → response
  .handle("ping", () => "pong")

  // Typed arguments with automatic encoding
  .handle("add", ({ a, b }) => (a as number) + (b as number))

  // Async handlers are first-class
  .handle("delay", async ({ ms }) => {
    await new Promise((r) => setTimeout(r, ms as number));
    return `done after ${ms}ms`;
  })

  // Echo anything back
  .handle("echo", ({ message }) => message)

  // Fire-and-forget events (no reply)
  .onEvent("log", ({ level, message }) => {
    console.log(`  [event:log] [${level}] ${message}`);
  });

console.log(" Server ready — waiting for calls. Press Ctrl+C to stop.\n");

// Keep the process alive. Ctrl+C triggers graceful shutdown.
process.on?.("SIGINT", () => {
  server.close();
  process.exit(0);
});
process.on?.("SIGTERM", () => {
  server.close();
  process.exit(0);
});

// Deno-compatible keep-alive
if (typeof Deno !== "undefined") {
  // Deno: top-level await is sufficient; server polls in background.
  await new Promise(() => {}); // never resolves
}
