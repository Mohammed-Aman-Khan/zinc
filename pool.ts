import type { RingLike } from "./rpc.ts";

export interface ChannelConfig {
  name: string;
  reqRingName: string;
  repRingName: string;
  create: boolean;
}

export interface ChannelStats {
  name: string;
  sent: bigint;
  received: bigint;
  errors: bigint;
  avgLatencyUs: number;
  lastPingUs: number;
  healthy: boolean;
}

interface ChannelEntry {
  config: ChannelConfig;
  reqRing: RingLike;
  repRing: RingLike;
  stats: {
    sent: bigint;
    received: bigint;
    errors: bigint;
    latencies: number[];
    latIdx: number;
    lastPing: number;
    healthy: boolean;
  };
}

export type RingFactory = (name: string, create: boolean) => RingLike;

export class RingPool {
  readonly #factory: RingFactory;
  readonly #channels: Map<string, ChannelEntry> = new Map();
  readonly #workers: string[] = [];
  #rrIndex = 0;
  #healthTimer: ReturnType<typeof setInterval> | null = null;
  readonly #latBufSize = 64;

  constructor(factory: RingFactory) {
    this.#factory = factory;
  }
  addChannel(config: ChannelConfig): this {
    if (this.#channels.has(config.name)) {
      throw new Error(`Channel '${config.name}' already registered`);
    }

    const reqRing = this.#factory(config.reqRingName, config.create);
    const repRing = this.#factory(config.repRingName, !config.create);

    this.#channels.set(config.name, {
      config,
      reqRing,
      repRing,
      stats: {
        sent: 0n,
        received: 0n,
        errors: 0n,
        latencies: new Array(this.#latBufSize).fill(0),
        latIdx: 0,
        lastPing: 0,
        healthy: true,
      },
    });

    return this;
  }

  addWorker(channelName: string): this {
    if (!this.#channels.has(channelName)) {
      throw new Error(`Unknown channel: '${channelName}'`);
    }
    this.#workers.push(channelName);
    return this;
  }

  removeChannel(name: string): void {
    const entry = this.#channels.get(name);
    if (!entry) return;

    (entry.reqRing as any).close?.();
    (entry.repRing as any).close?.();
    this.#channels.delete(name);
    const idx = this.#workers.indexOf(name);
    if (idx !== -1) this.#workers.splice(idx, 1);
  }

  channel(name: string): { req: RingLike; rep: RingLike } {
    const entry = this.#channels.get(name);
    if (!entry) throw new Error(`Unknown channel: '${name}'`);
    return { req: entry.reqRing, rep: entry.repRing };
  }

  nextWorker(): { name: string; req: RingLike; rep: RingLike } {
    if (this.#workers.length === 0) throw new Error("No workers registered");

    const start = this.#rrIndex;
    let attempts = 0;

    while (attempts < this.#workers.length) {
      const idx = this.#rrIndex % this.#workers.length;
      this.#rrIndex = (this.#rrIndex + 1) % this.#workers.length;
      attempts++;

      const name = this.#workers[idx]!;
      const entry = this.#channels.get(name)!;
      if (entry.stats.healthy) {
        return { name, req: entry.reqRing, rep: entry.repRing };
      }
    }

    throw new Error("No healthy workers available");
  }

  recordSend(channelName: string): void {
    const e = this.#channels.get(channelName);
    if (e) e.stats.sent++;
  }

  recordRecv(channelName: string, latencyUs: number): void {
    const e = this.#channels.get(channelName);
    if (!e) return;
    e.stats.received++;
    e.stats.latencies[e.stats.latIdx] = latencyUs;
    e.stats.latIdx = (e.stats.latIdx + 1) % this.#latBufSize;
  }

  recordError(channelName: string): void {
    const e = this.#channels.get(channelName);
    if (e) {
      e.stats.errors++;
      e.stats.healthy = false;
    }
  }

  allStats(): ChannelStats[] {
    return Array.from(this.#channels.entries()).map(([name, e]) => {
      const lats = e.stats.latencies.filter((x) => x > 0);
      const avg =
        lats.length > 0 ? lats.reduce((a, b) => a + b, 0) / lats.length : 0;
      return {
        name,
        sent: e.stats.sent,
        received: e.stats.received,
        errors: e.stats.errors,
        avgLatencyUs: avg,
        lastPingUs: e.stats.lastPing,
        healthy: e.stats.healthy,
      };
    });
  }

  startHealthCheck(intervalMs = 5000, timeoutMs = 1000): void {
    this.#healthTimer = setInterval(async () => {
      for (const name of this.#workers) {
        const entry = this.#channels.get(name);
        if (!entry) continue;
        try {
          const t0 = performance.now();
          const ping = new Uint8Array(0);
          entry.reqRing.send(0x04, ping);

          await new Promise((r) =>
            setTimeout(r, Math.min(timeoutMs, intervalMs / 4)),
          );
          const msg = entry.repRing.poll();
          const latUs = (performance.now() - t0) * 1000;
          if (msg && msg.msgType === 0x05) {
            entry.stats.healthy = true;
            entry.stats.lastPing = latUs;
          } else {
            entry.stats.healthy = false;
          }
        } catch {
          entry.stats.healthy = false;
          entry.stats.errors++;
        }
      }
    }, intervalMs);
  }

  stopHealthCheck(): void {
    if (this.#healthTimer) {
      clearInterval(this.#healthTimer);
      this.#healthTimer = null;
    }
  }

  close(): void {
    this.stopHealthCheck();
    for (const name of this.#channels.keys()) {
      this.removeChannel(name);
    }
  }

  get channelCount(): number {
    return this.#channels.size;
  }
  get workerCount(): number {
    return this.#workers.length;
  }
}
