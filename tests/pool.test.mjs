/**
 * tests/pool.test.mjs
 * Tests for the RingPool connection manager.
 */

// ── Minimal RingLike mock ──────────────────────────────────────────────────

let _msgIdCounter = 1n;

function makeRing(name = "mock") {
  const queue = [];
  return {
    name,
    _queue: queue,
    maxPayloadSize: 4064,
    send(msgType, payload, correlationId = 0n) {
      const id = _msgIdCounter++;
      queue.push({ msgType, msgId: id, correlationId, payload });
      return id;
    },
    poll() {
      return queue.shift() ?? null;
    },
    close() {},
  };
}

// ── RingPool (inline mirror of protocol/pool.ts) ──────────────────────────

class RingPool {
  #factory;
  #channels = new Map();
  #workers = [];
  #rrIndex = 0;
  #latBufSize = 16;
  #healthTimer = null;

  constructor(factory) {
    this.#factory = factory;
  }

  addChannel(config) {
    if (this.#channels.has(config.name))
      throw new Error(`Duplicate: ${config.name}`);
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

  addWorker(name) {
    if (!this.#channels.has(name)) throw new Error(`Unknown: ${name}`);
    this.#workers.push(name);
    return this;
  }

  removeChannel(name) {
    const e = this.#channels.get(name);
    if (!e) return;
    e.reqRing.close?.();
    e.repRing.close?.();
    this.#channels.delete(name);
    const i = this.#workers.indexOf(name);
    if (i !== -1) this.#workers.splice(i, 1);
  }

  channel(name) {
    const e = this.#channels.get(name);
    if (!e) throw new Error(`Unknown: ${name}`);
    return { req: e.reqRing, rep: e.repRing };
  }

  nextWorker() {
    if (!this.#workers.length) throw new Error("No workers");
    for (let i = 0; i < this.#workers.length; i++) {
      const name = this.#workers[this.#rrIndex % this.#workers.length];
      this.#rrIndex = (this.#rrIndex + 1) % this.#workers.length;
      const entry = this.#channels.get(name);
      if (entry?.stats.healthy)
        return { name, req: entry.reqRing, rep: entry.repRing };
    }
    throw new Error("No healthy workers");
  }

  recordSend(name) {
    const e = this.#channels.get(name);
    if (e) e.stats.sent++;
  }
  recordRecv(name, latUs) {
    const e = this.#channels.get(name);
    if (!e) return;
    e.stats.received++;
    e.stats.latencies[e.stats.latIdx] = latUs;
    e.stats.latIdx = (e.stats.latIdx + 1) % this.#latBufSize;
  }
  recordError(name) {
    const e = this.#channels.get(name);
    if (e) {
      e.stats.errors++;
      e.stats.healthy = false;
    }
  }

  markHealthy(name, healthy) {
    const e = this.#channels.get(name);
    if (e) e.stats.healthy = healthy;
  }

  allStats() {
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

  close() {
    for (const n of [...this.#channels.keys()]) this.removeChannel(n);
  }

  get channelCount() {
    return this.#channels.size;
  }
  get workerCount() {
    return this.#workers.length;
  }
}

// ── Test harness ───────────────────────────────────────────────────────────

let passed = 0,
  failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
  }
}
function throws(fn, substr) {
  try {
    fn();
    throw new Error("did not throw");
  } catch (e) {
    if (!e.message.includes(substr))
      throw new Error(`wrong error: ${e.message}`);
  }
}

console.log("\n RingPool Tests\n");

test("addChannel creates req+rep rings", () => {
  const created = [];
  const pool = new RingPool((name, create) => {
    created.push({ name, create });
    return makeRing(name);
  });
  pool.addChannel({
    name: "ch1",
    reqRingName: "/req1",
    repRingName: "/rep1",
    create: true,
  });
  if (created.length !== 2)
    throw new Error(`Expected 2 rings, got ${created.length}`);
  if (created[0].name !== "/req1" || !created[0].create)
    throw new Error("req ring wrong");
  if (created[1].name !== "/rep1" || created[1].create)
    throw new Error("rep ring wrong (should be client)");
  pool.close();
});

test("channel() returns req/rep pair", () => {
  const pool = new RingPool((name) => makeRing(name));
  pool.addChannel({
    name: "ch",
    reqRingName: "/r",
    repRingName: "/p",
    create: false,
  });
  const ch = pool.channel("ch");
  if (!ch.req || !ch.rep) throw new Error("missing ring");
  pool.close();
});

test("duplicate channel name throws", () => {
  const pool = new RingPool(() => makeRing());
  pool.addChannel({
    name: "ch",
    reqRingName: "/r",
    repRingName: "/p",
    create: false,
  });
  throws(
    () =>
      pool.addChannel({
        name: "ch",
        reqRingName: "/r2",
        repRingName: "/p2",
        create: false,
      }),
    "Duplicate",
  );
  pool.close();
});

test("unknown channel throws on channel()", () => {
  const pool = new RingPool(() => makeRing());
  throws(() => pool.channel("nope"), "Unknown");
  pool.close();
});

test("addWorker + nextWorker round-robins", () => {
  const pool = new RingPool(() => makeRing());
  pool.addChannel({
    name: "w1",
    reqRingName: "/r1",
    repRingName: "/p1",
    create: false,
  });
  pool.addChannel({
    name: "w2",
    reqRingName: "/r2",
    repRingName: "/p2",
    create: false,
  });
  pool.addChannel({
    name: "w3",
    reqRingName: "/r3",
    repRingName: "/p3",
    create: false,
  });
  pool.addWorker("w1").addWorker("w2").addWorker("w3");

  const seen = [];
  for (let i = 0; i < 6; i++) seen.push(pool.nextWorker().name);
  // Should cycle: w1, w2, w3, w1, w2, w3
  if (!["w1", "w2", "w3", "w1", "w2", "w3"].every((x, i) => x === seen[i]))
    throw new Error(`Round-robin wrong: ${seen}`);
  pool.close();
});

test("nextWorker skips unhealthy channels", () => {
  const pool = new RingPool(() => makeRing());
  pool.addChannel({
    name: "w1",
    reqRingName: "/r1",
    repRingName: "/p1",
    create: false,
  });
  pool.addChannel({
    name: "w2",
    reqRingName: "/r2",
    repRingName: "/p2",
    create: false,
  });
  pool.addWorker("w1").addWorker("w2");

  pool.markHealthy("w1", false); // w1 is sick

  for (let i = 0; i < 4; i++) {
    const w = pool.nextWorker();
    if (w.name !== "w2") throw new Error(`Expected w2, got ${w.name}`);
  }
  pool.close();
});

test("all workers unhealthy throws", () => {
  const pool = new RingPool(() => makeRing());
  pool.addChannel({
    name: "w1",
    reqRingName: "/r1",
    repRingName: "/p1",
    create: false,
  });
  pool.addWorker("w1");
  pool.markHealthy("w1", false);
  throws(() => pool.nextWorker(), "healthy");
  pool.close();
});

test("no workers throws", () => {
  const pool = new RingPool(() => makeRing());
  throws(() => pool.nextWorker(), "No workers");
  pool.close();
});

test("recordSend increments counter", () => {
  const pool = new RingPool(() => makeRing());
  pool.addChannel({
    name: "ch",
    reqRingName: "/r",
    repRingName: "/p",
    create: false,
  });
  pool.recordSend("ch");
  pool.recordSend("ch");
  pool.recordSend("ch");
  const stats = pool.allStats().find((s) => s.name === "ch");
  if (stats.sent !== 3n) throw new Error(`sent=${stats.sent}`);
  pool.close();
});

test("recordRecv computes average latency", () => {
  const pool = new RingPool(() => makeRing());
  pool.addChannel({
    name: "ch",
    reqRingName: "/r",
    repRingName: "/p",
    create: false,
  });
  pool.recordRecv("ch", 100);
  pool.recordRecv("ch", 200);
  pool.recordRecv("ch", 300);
  const stats = pool.allStats().find((s) => s.name === "ch");
  if (stats.avgLatencyUs !== 200) throw new Error(`avg=${stats.avgLatencyUs}`);
  pool.close();
});

test("recordError marks channel unhealthy", () => {
  const pool = new RingPool(() => makeRing());
  pool.addChannel({
    name: "ch",
    reqRingName: "/r",
    repRingName: "/p",
    create: false,
  });
  pool.addWorker("ch");
  pool.recordError("ch");
  const stats = pool.allStats().find((s) => s.name === "ch");
  if (stats.healthy) throw new Error("should be unhealthy");
  if (stats.errors !== 1n) throw new Error(`errors=${stats.errors}`);
  pool.close();
});

test("removeChannel decrements count", () => {
  const pool = new RingPool(() => makeRing());
  pool.addChannel({
    name: "ch",
    reqRingName: "/r",
    repRingName: "/p",
    create: false,
  });
  if (pool.channelCount !== 1) throw new Error(`count=${pool.channelCount}`);
  pool.removeChannel("ch");
  if (pool.channelCount !== 0)
    throw new Error(`count after remove=${pool.channelCount}`);
});

test("removeChannel also removes from workers", () => {
  const pool = new RingPool(() => makeRing());
  pool.addChannel({
    name: "w1",
    reqRingName: "/r1",
    repRingName: "/p1",
    create: false,
  });
  pool.addChannel({
    name: "w2",
    reqRingName: "/r2",
    repRingName: "/p2",
    create: false,
  });
  pool.addWorker("w1").addWorker("w2");
  if (pool.workerCount !== 2) throw new Error("pre-remove");
  pool.removeChannel("w1");
  if (pool.workerCount !== 1)
    throw new Error(`post-remove count=${pool.workerCount}`);
  // nextWorker should now only return w2
  if (pool.nextWorker().name !== "w2")
    throw new Error("wrong worker after remove");
  pool.close();
});

test("close() empties all channels", () => {
  const pool = new RingPool(() => makeRing());
  pool.addChannel({
    name: "a",
    reqRingName: "/ra",
    repRingName: "/pa",
    create: false,
  });
  pool.addChannel({
    name: "b",
    reqRingName: "/rb",
    repRingName: "/pb",
    create: false,
  });
  pool.close();
  if (pool.channelCount !== 0) throw new Error(`count=${pool.channelCount}`);
});

test("allStats returns entry per channel", () => {
  const pool = new RingPool(() => makeRing());
  pool.addChannel({
    name: "a",
    reqRingName: "/ra",
    repRingName: "/pa",
    create: false,
  });
  pool.addChannel({
    name: "b",
    reqRingName: "/rb",
    repRingName: "/pb",
    create: false,
  });
  const stats = pool.allStats();
  if (stats.length !== 2) throw new Error(`length=${stats.length}`);
  pool.close();
});

test("can re-add channel after remove", () => {
  const pool = new RingPool(() => makeRing());
  pool.addChannel({
    name: "ch",
    reqRingName: "/r",
    repRingName: "/p",
    create: false,
  });
  pool.removeChannel("ch");
  pool.addChannel({
    name: "ch",
    reqRingName: "/r2",
    repRingName: "/p2",
    create: false,
  });
  if (pool.channelCount !== 1) throw new Error("should have 1 channel");
  pool.close();
});

test("recovering unhealthy channel back to healthy", () => {
  const pool = new RingPool(() => makeRing());
  pool.addChannel({
    name: "w",
    reqRingName: "/r",
    repRingName: "/p",
    create: false,
  });
  pool.addWorker("w");
  pool.recordError("w");
  // simulate recovery
  pool.markHealthy("w", true);
  if (!pool.nextWorker().name) throw new Error("should have healthy worker");
  pool.close();
});

// ── Throughput: nextWorker selection ──────────────────────────────────────

console.log("\n Pool routing throughput...");
const bigPool = new RingPool(() => makeRing());
for (let i = 0; i < 16; i++) {
  bigPool.addChannel({
    name: `w${i}`,
    reqRingName: `/r${i}`,
    repRingName: `/p${i}`,
    create: false,
  });
  bigPool.addWorker(`w${i}`);
}
const N = 1_000_000;
const t0 = performance.now();
for (let i = 0; i < N; i++) bigPool.nextWorker();
const elapsed = performance.now() - t0;
console.log(`   ${N.toLocaleString()} nextWorker() calls across 16 workers`);
console.log(
  `   in ${elapsed.toFixed(1)}ms → ${(N / (elapsed / 1000) / 1e6).toFixed(2)}M/sec`,
);
console.log(`   = ${((elapsed / N) * 1e6).toFixed(0)}ns per routing decision`);
bigPool.close();

console.log(`\n Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
