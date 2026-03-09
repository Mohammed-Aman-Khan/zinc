/**
 * examples/bun_server.ts
 * Zinc — Universal IPC Bridge for JS Runtimes
 *
 * Demo server (Bun). Accepts calls from any runtime — Node.js, Deno, or Bun.
 *
 * Run:
 *   bun run examples/bun_server.ts
 *
 * Then in another terminal run one of:
 *   bun  run examples/deno_client.ts    (or use deno run ...)
 *   node --import tsx/esm examples/node_client.mjs
 *
 * For a simpler quickstart, see examples/quickstart/.
 */

import { serve } from "../src/index.ts";
import process from "node:process";

console.log(" Zinc — Demo Server (Bun)");
console.log("   Channel: demo-channel\n");

const server = await serve("demo-channel");

server
  .handle("ping", () => "pong")

  .handle("add", ({ a, b }) => {
    const result = (a as number) + (b as number);
    console.log(`  [handler] add(${a}, ${b}) = ${result}`);
    return result;
  })

  .handle("echo", ({ message }) => {
    console.log(`  [handler] echo: ${message}`);
    return message;
  })

  .handle("fibonacci", ({ n }) => {
    const fib = (x: number): number => (x <= 1 ? x : fib(x - 1) + fib(x - 2));
    const result = fib(n as number);
    console.log(`  [handler] fibonacci(${n}) = ${result}`);
    return result;
  })

  .handle("bulk_sum", ({ values }) => {
    const arr = values as number[];
    const result = arr.reduce((a, b) => a + b, 0);
    console.log(`  [handler] bulk_sum(${arr.length} items) = ${result}`);
    return result;
  })

  .onEvent("log", ({ level, message }) => {
    console.log(`  [event:log] [${level}] ${message}`);
  });

console.log(" Server ready. Waiting for calls. Press Ctrl+C to stop.\n");

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
