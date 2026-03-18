/** src/channel.ts — the two functions most users ever need: serve() and connect(). */

import { RPCNode } from "../protocol/rpc.ts";
import { openRing } from "./runtime.ts";
import type {
  ZincServer,
  ZincClient,
  Handler,
  ServeOptions,
  ConnectOptions,
} from "./types.ts";

/**
 * Open a server on `channelName`. Creates the shm ring, starts polling,
 * dispatches incoming CALLs to registered handlers.
 *
 * @example
 * const server = await serve('my-service')
 * server.handle('add', ({ a, b }) => (a as number) + (b as number))
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

/**
 * Attach to an existing server as a client. Channel name must match `serve()`.
 *
 * @example
 * const client = await connect('my-service')
 * const sum = await client.call('add', { a: 40, b: 2 }) // 42
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

function toShmName(name: string): string {
  if (name.startsWith("/")) return name;
  return `/zinc-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}
