/**
 * tests/integration_sim.mjs
 * Full pipeline simulation: in-process ring buffer + RPC roundtrip.
 * No native dependencies — uses a pure-JS ring simulation.
 *
 * Validates the complete message flow:
 *   Caller → encode → send → ring → recv → decode → handler → encode → reply → decode
 */

// ── Inline FlatMsg (same logic as protocol/flat_msg.ts) ───────────────────

const TAG = {
  u32: 0x01,
  u64: 0x02,
  f64: 0x03,
  bool: 0x04,
  string: 0x05,
  bytes: 0x06,
  null: 0x07,
  i32: 0x08,
  i64: 0x09,
};
const ENC = new TextEncoder();
const DEC = new TextDecoder();

function encodeValue(f) {
  switch (f.type) {
    case "null":
      return new Uint8Array(0);
    case "bool": {
      const b = new Uint8Array(1);
      b[0] = f.value ? 1 : 0;
      return b;
    }
    case "u32": {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, f.value, true);
      return b;
    }
    case "i32": {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setInt32(0, f.value, true);
      return b;
    }
    case "f64": {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, f.value, true);
      return b;
    }
    case "u64": {
      const b = new Uint8Array(8);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, Number(f.value & 0xffffffffn), true);
      dv.setUint32(4, Number(f.value >> 32n), true);
      return b;
    }
    case "i64": {
      const b = new Uint8Array(8);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, Number(BigInt.asUintN(32, f.value)), true);
      dv.setUint32(4, Number(BigInt.asUintN(32, f.value >> 32n)), true);
      return b;
    }
    case "string":
      return ENC.encode(f.value);
    case "bytes":
      return f.value;
  }
}

function encode(msg) {
  const fields = Object.entries(msg);
  const kbs = [],
    vbs = [];
  let total = 1;
  for (let i = 0; i < fields.length; i++) {
    const kb = ENC.encode(fields[i][0]);
    const vb = encodeValue(fields[i][1]);
    kbs[i] = kb;
    vbs[i] = vb;
    total += 1 + 2 + kb.length + 4 + vb.length;
  }
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out[0] = fields.length;
  let pos = 1;
  for (let i = 0; i < fields.length; i++) {
    const kb = kbs[i],
      vb = vbs[i];
    const tag = TAG[fields[i][1].type];
    dv.setUint8(pos++, tag);
    dv.setUint16(pos, kb.length, true);
    pos += 2;
    out.set(kb, pos);
    pos += kb.length;
    dv.setUint32(pos, vb.length, true);
    pos += 4;
    out.set(vb, pos);
    pos += vb.length;
  }
  return out;
}

function decodeValue(tag, b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (tag) {
    case 0x07:
      return { type: "null" };
    case 0x04:
      return { type: "bool", value: b[0] !== 0 };
    case 0x01:
      return { type: "u32", value: dv.getUint32(0, true) };
    case 0x08:
      return { type: "i32", value: dv.getInt32(0, true) };
    case 0x03:
      return { type: "f64", value: dv.getFloat64(0, true) };
    case 0x02: {
      const lo = BigInt(dv.getUint32(0, true)),
        hi = BigInt(dv.getUint32(4, true));
      return { type: "u64", value: (hi << 32n) | lo };
    }
    case 0x09: {
      const lo = BigInt(dv.getUint32(0, true)),
        hi = BigInt(dv.getInt32(4, true));
      return { type: "i64", value: (hi << 32n) | lo };
    }
    case 0x05:
      return { type: "string", value: DEC.decode(b) };
    case 0x06:
      return { type: "bytes", value: b.slice() };
  }
}

function decode(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = dv.getUint8(0);
  const msg = {};
  let off = 1;
  for (let i = 0; i < count; i++) {
    const tag = dv.getUint8(off++);
    const kl = dv.getUint16(off, true);
    off += 2;
    const key = DEC.decode(buf.subarray(off, off + kl));
    off += kl;
    const vl = dv.getUint32(off, true);
    off += 4;
    msg[key] = decodeValue(tag, buf.subarray(off, off + vl));
    off += vl;
  }
  return msg;
}

function encodeAuto(obj) {
  const msg = {};
  for (const [k, val] of Object.entries(obj)) {
    if (val === null || val === undefined) msg[k] = { type: "null" };
    else if (typeof val === "boolean") msg[k] = { type: "bool", value: val };
    else if (typeof val === "bigint") msg[k] = { type: "i64", value: val };
    else if (typeof val === "number") {
      if (Number.isInteger(val) && val >= 0 && val <= 0xffffffff)
        msg[k] = { type: "u32", value: val };
      else msg[k] = { type: "f64", value: val };
    } else if (typeof val === "string") msg[k] = { type: "string", value: val };
    else if (val instanceof Uint8Array) msg[k] = { type: "bytes", value: val };
    else msg[k] = { type: "string", value: JSON.stringify(val) };
  }
  return encode(msg);
}

function decodeAuto(buf) {
  const msg = decode(buf);
  const out = {};
  for (const [k, fv] of Object.entries(msg)) {
    switch (fv.type) {
      case "null":
        out[k] = null;
        break;
      case "bool":
      case "u32":
      case "i32":
      case "f64":
        out[k] = fv.value;
        break;
      case "u64":
      case "i64":
        out[k] = fv.value;
        break;
      case "string":
        out[k] = fv.value;
        break;
      case "bytes":
        out[k] = fv.value;
        break;
    }
  }
  return out;
}

// ── Simulated in-process ring (FIFO queue) ────────────────────────────────

class SimRing {
  #queue = [];
  #msgId = 1n;
  get maxPayloadSize() {
    return 4064;
  }

  send(msgType, payload, correlationId = 0n) {
    const id = this.#msgId++;
    this.#queue.push({
      msgType,
      msgId: id,
      correlationId,
      payload: Uint8Array.from(payload),
    });
    return id;
  }
  poll() {
    return this.#queue.shift() ?? null;
  }
}

// ── Two-ring RPC (mirrors protocol/rpc.ts corrected model) ────────────────
// reqRing: client → server  (CALLs flow this way)
// repRing: server → client  (REPLYs flow this way)

const MSG_CALL = 0x01,
  MSG_REPLY = 0x02,
  MSG_EVENT = 0x03;

class RPCServer {
  #req;
  #rep;
  #handlers = new Map();
  #timer = null;
  constructor(reqRing, repRing) {
    this.#req = reqRing;
    this.#rep = repRing;
  }
  register(method, handler) {
    this.#handlers.set(method, handler);
  }
  start(ms = 0) {
    this.#timer = setInterval(() => this.#tick(), ms);
  }
  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
  #tick() {
    let msg;
    while ((msg = this.#req.poll()) !== null) {
      if (msg.msgType === MSG_CALL) this.#handle(msg.msgId, msg.payload);
    }
  }
  async #handle(msgId, payload) {
    let result,
      isError = false;
    try {
      const args = decodeAuto(payload);
      const m = args.method;
      delete args.method;
      const h = this.#handlers.get(m);
      if (!h) throw new Error(`Unknown RPC method: '${m}'`);
      result = await h(args);
    } catch (e) {
      isError = true;
      result = e.message;
    }
    const rp = encodeAuto(
      isError ? { error: result } : { result: result ?? null },
    );
    try {
      this.#rep.send(MSG_REPLY, rp, msgId);
    } catch {}
  }
}

class RPCClient {
  #req;
  #rep;
  #pending = new Map();
  #timer = null;
  constructor(reqRing, repRing) {
    this.#req = reqRing;
    this.#rep = repRing;
  }
  call(method, args = {}, ms = 5000) {
    const payload = encodeAuto({ method, ...args });
    const msgId = this.#req.send(MSG_CALL, payload);
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.#pending.delete(msgId);
        rej(new Error(`Timeout:${method}`));
      }, ms);
      this.#pending.set(msgId, { resolve: res, reject: rej, timer: t });
    });
  }
  start(ms = 0) {
    this.#timer = setInterval(() => this.#tick(), ms);
  }
  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
  #tick() {
    let msg;
    while ((msg = this.#rep.poll()) !== null) {
      if (msg.msgType !== MSG_REPLY) continue;
      const p = this.#pending.get(msg.correlationId);
      if (!p) continue;
      clearTimeout(p.timer);
      this.#pending.delete(msg.correlationId);
      const obj = decodeAuto(msg.payload);
      if ("error" in obj) p.reject(new Error(obj.error));
      else p.resolve(obj.result);
    }
  }
}

// ── Test harness ───────────────────────────────────────────────────────────

let passed = 0,
  failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`   ${name}`);
    passed++;
  } catch (e) {
    console.log(`   ${name}: ${e.message}`);
    failed++;
  }
}

// ── Setup: two rings (reqRing: client→server, repRing: server→client) ────

console.log("\n🔗 Universal-IPC Bridge — Integration Simulation\n");

const reqRing = new SimRing();
const repRing = new SimRing();
const server = new RPCServer(reqRing, repRing);
const client = new RPCClient(reqRing, repRing);

// Register server handlers
server.register("ping", () => "pong");
server.register("add", ({ a, b }) => a + b);
server.register("echo", ({ message }) => message);
server.register("fibonacci", ({ n }) => {
  const fib = (x) => (x <= 1 ? x : fib(x - 1) + fib(x - 2));
  return fib(n);
});
server.register("greet", ({ name }) => `Hello, ${name}!`);
server.register("fail", () => {
  throw new Error("intentional failure");
});

// Run both tick loops
server.start(0);
client.start(0);

// ── Tests ──────────────────────────────────────────────────────────────────

await test("ping/pong", async () => {
  const r = await client.call("ping");
  if (r !== "pong") throw new Error(`got ${r}`);
});

await test("add(40,2)=42", async () => {
  const r = await client.call("add", { a: 40, b: 2 });
  if (r !== 42) throw new Error(`got ${r}`);
});

await test("echo unicode", async () => {
  const r = await client.call("echo", { message: "Hello 世界 🌍" });
  if (r !== "Hello 世界 🌍") throw new Error(`got ${r}`);
});

await test("fibonacci(20)", async () => {
  const r = await client.call("fibonacci", { n: 20 });
  if (r !== 6765) throw new Error(`got ${r}`);
});

await test("greet string", async () => {
  const r = await client.call("greet", { name: "Zig" });
  if (r !== "Hello, Zig!") throw new Error(`got ${r}`);
});

await test("error propagation", async () => {
  try {
    await client.call("fail");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("intentional"))
      throw new Error(`wrong error: ${e.message}`);
  }
});

await test("unknown method error", async () => {
  try {
    await client.call("doesNotExist");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("Unknown"))
      throw new Error(`wrong error: ${e.message}`);
  }
});

await test("concurrent calls (100)", async () => {
  const jobs = [];
  for (let i = 0; i < 100; i++) jobs.push(client.call("add", { a: i, b: i }));
  const results = await Promise.all(jobs);
  for (let i = 0; i < 100; i++)
    if (results[i] !== i * 2) throw new Error(`call ${i}: got ${results[i]}`);
});

await test("large payload (3KB string)", async () => {
  const big = "X".repeat(3000);
  const r = await client.call("echo", { message: big });
  if (r !== big) throw new Error("payload corrupted");
});

await test("boolean args", async () => {
  server.register("not", ({ v }) => !v);
  const r = await client.call("not", { v: true });
  if (r !== false) throw new Error(`got ${r}`);
});

await test("null result", async () => {
  server.register("nothing", () => null);
  const r = await client.call("nothing");
  if (r !== null) throw new Error(`got ${r}`);
});

// ── Throughput bench ───────────────────────────────────────────────────────

console.log("\n Throughput: 1,000 concurrent RPC calls...");
const N = 1000;
const t0 = performance.now();
const jobs = [];
for (let i = 0; i < N; i++) jobs.push(client.call("add", { a: i, b: i * 2 }));
await Promise.all(jobs);
const elapsed = performance.now() - t0;
console.log(`   ${N} calls in ${elapsed.toFixed(1)}ms`);
console.log(`   = ${(N / (elapsed / 1000)).toFixed(0)} RPC calls/sec`);
console.log(`   = ${((elapsed / N) * 1000).toFixed(0)} µs per round-trip`);

// Verify all results
for (let i = 0; i < N; i++) {
  if ((await Promise.resolve(jobs[i])) !== i + i * 2) {
    failed++;
    break;
  }
}

console.log("\n Serialization: 100,000 encode+decode cycles...");
const benchMsg = {
  method: { type: "string", value: "add" },
  a: { type: "u32", value: 40 },
  b: { type: "u32", value: 2 },
};
const ITERS = 100_000;
const ts = performance.now();
for (let i = 0; i < ITERS; i++) {
  decode(encode(benchMsg));
}
const te = performance.now() - ts;
console.log(
  `   ${ITERS.toLocaleString()} in ${te.toFixed(1)}ms → ${(ITERS / (te / 1000) / 1e6).toFixed(2)}M/sec`,
);

// ── Cleanup ────────────────────────────────────────────────────────────────

server.stop();
client.stop();

console.log(`\n Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
