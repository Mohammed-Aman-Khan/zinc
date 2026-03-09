/**
 * src/channel.ts
 * Zinc — Universal IPC Bridge for JS Runtimes
 *
 * The high-level developer-facing API: serve() and connect().
 * These two functions are the entire surface area a typical developer needs.
 *
 * Under the hood they:
 *   1. Auto-detect the current JS runtime (Bun, Node.js, or Deno).
 *   2. Load the correct native adapter for that runtime.
 *   3. Open the POSIX shared-memory ring buffer.
 *   4. Wrap it with the RPCNode protocol layer.
 *   5. Return a clean, typed ZincServer or ZincClient.
 *
 * Developer pain point solved:
 *   Before — every runtime needed hand-written FFI glue + manual ring management.
 *   After  — two functions, zero configuration, any runtime.
 */

import { RPCNode } from "../protocol/rpc.ts";
import { openRing } from "./runtime.ts";
import type {
  ZincServer,
  ZincClient,
  Handler,
  ServeOptions,
  ConnectOptions,
} from "./types.ts";

// ── serve() ───────────────────────────────────────────────────────────────────

/**
 * Create a Zinc server on the given channel name.
 *
 * The server creates the shared-memory ring buffer (first-writer wins),
 * starts polling, and dispatches incoming calls to registered handlers.
 *
 * @param channelName  Unique name for this IPC channel, e.g. `"my-service"`.
 *                     A POSIX shm prefix (`/zinc-`) is added automatically.
 * @param options      Optional tuning parameters.
 *
 * @example
 * import { serve } from 'zinc'
 *
 * const server = await serve('my-service')
 *
 * server
 *   .handle('add', ({ a, b }) => (a as number) + (b as number))
 *   .handle('ping', () => 'pong')
 *
 * // Server polls automatically. Call server.close() to shut down.
 */
export async function serve(
  channelName: string,
  options: ServeOptions = {},
): Promise<ZincServer> {
  const shmName = toShmName(channelName);
  const ring = await openRing(shmName, /* create= */ true);
  const rpc = new RPCNode(ring);

  rpc.start(options.pollIntervalMs ?? 0);

  // Fluent, chainable server interface.
  const server: ZincServer = {
    handle(method: string, handler: Handler): ZincServer {
      rpc.register(method, handler);
      return server;
    },
    onEvent(event: string, handler: Handler): ZincServer {
      rpc.onEvent(event, handler);
      return server;
    },
    close(): void {
      rpc.stop();
      (ring as any).unlink?.();
      (ring as any).close?.();
    },
  };

  return server;
}

// ── connect() ─────────────────────────────────────────────────────────────────

/**
 * Connect to an existing Zinc server as a client.
 *
 * The client attaches to the shared-memory ring buffer created by the server,
 * starts polling for replies, and exposes `call()` and `emit()`.
 *
 * @param channelName  Must match the name used in `serve()`.
 * @param options      Optional tuning parameters.
 *
 * @example
 * import { connect } from 'zinc'
 *
 * const client = await connect('my-service')
 *
 * const sum = await client.call('add', { a: 40, b: 2 })
 * console.log(sum) // 42
 *
 * client.close()
 */
export async function connect(
  channelName: string,
  options: ConnectOptions = {},
): Promise<ZincClient> {
  const shmName = toShmName(channelName);
  const ring = await openRing(shmName, /* create= */ false);
  const rpc = new RPCNode(ring);

  rpc.start(options.pollIntervalMs ?? 0);

  const client: ZincClient = {
    call(
      method: string,
      args?: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<unknown> {
      return rpc.call(method, args, timeoutMs ?? options.defaultTimeoutMs);
    },
    emit(event: string, data?: Record<string, unknown>): void {
      rpc.emit(event, data ?? {});
    },
    close(): void {
      rpc.stop();
      (ring as any).close?.();
    },
  };

  return client;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalise a user-friendly channel name into a POSIX shm name. */
function toShmName(name: string): string {
  // Already looks like a POSIX name — use as-is.
  if (name.startsWith("/")) return name;
  // Strip non-alphanumeric characters and prepend the zinc namespace.
  return `/zinc-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}
