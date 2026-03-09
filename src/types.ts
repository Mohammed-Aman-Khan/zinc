/**
 * src/types.ts
 * Zinc — Universal IPC Bridge for JS Runtimes
 *
 * All public-facing TypeScript types exported from the Zinc package.
 */

// ── Handler types ─────────────────────────────────────────────────────────────

/** A function that handles an incoming RPC call. */
export type Handler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

// ── Server API ────────────────────────────────────────────────────────────────

/**
 * A Zinc server. Registers handlers and serves RPC calls from any connected
 * client regardless of which JS runtime the client runs on.
 */
export interface ZincServer {
  /**
   * Register an RPC handler.
   *
   * @example
   * server.handle('add', ({ a, b }) => (a as number) + (b as number))
   */
  handle(method: string, handler: Handler): ZincServer;

  /**
   * Subscribe to a fire-and-forget event from clients.
   *
   * @example
   * server.onEvent('log', ({ level, message }) => console.log(`[${level}] ${message}`))
   */
  onEvent(event: string, handler: Handler): ZincServer;

  /** Gracefully stop polling and release all native resources. */
  close(): void;
}

// ── Client API ────────────────────────────────────────────────────────────────

/**
 * A Zinc client. Calls RPC methods and emits events to a server running in
 * any JS runtime (Bun, Node.js, Deno) on the same machine.
 */
export interface ZincClient {
  /**
   * Call a remote method and await the result.
   *
   * @throws if the server returns an error or the call times out.
   *
   * @example
   * const result = await client.call('add', { a: 1, b: 2 })
   */
  call(
    method: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;

  /**
   * Emit a fire-and-forget event. Does not wait for acknowledgement.
   *
   * @example
   * client.emit('log', { level: 'info', message: 'Hello!' })
   */
  emit(event: string, data?: Record<string, unknown>): void;

  /** Stop polling and release all native resources. */
  close(): void;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface ServeOptions {
  /**
   * How fast to poll for incoming messages.
   * 0 = as fast as possible (lowest latency, highest CPU).
   * Default: 0
   */
  pollIntervalMs?: number;
}

export interface ConnectOptions {
  /**
   * How fast to poll for replies.
   * 0 = as fast as possible.
   * Default: 0
   */
  pollIntervalMs?: number;

  /**
   * Default timeout for calls in milliseconds.
   * Default: 5000
   */
  defaultTimeoutMs?: number;
}

// ── Runtime ───────────────────────────────────────────────────────────────────

/** The detected JS runtime. */
export type ZincRuntime = "bun" | "deno" | "node";
