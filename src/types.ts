/** All public-facing TypeScript types for the Zinc package. */

export type Handler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

/** Returned by `serve()`. Register handlers, then call `close()` when done. */
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

/** Returned by `connect()`. Call remote methods, emit events, then `close()`. */
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

export interface ServeOptions {
  /** Poll interval in ms. 0 = as fast as possible (lowest latency, highest CPU). */
  pollIntervalMs?: number;
}

export interface ConnectOptions {
  /** Poll interval in ms for reply checking. Default: 0. */
  pollIntervalMs?: number;
  /** Default call timeout in ms. Default: 5000. */
  defaultTimeoutMs?: number;
}

export type ZincRuntime = "bun" | "deno" | "node";

/** A cross-process shared memory region. */
export interface SharedMemoryRegion {
  /** The raw ArrayBuffer backed by mmap'd shared memory. Zero-copy. */
  readonly buffer: ArrayBuffer;
  /** Size of the region in bytes. */
  readonly byteLength: number;
  /** Unlink the shared memory segment from the filesystem. */
  unlink(): void;
  /** Unmap and close the region. */
  close(): void;
}
