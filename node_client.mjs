/**
 * demo/node_client.mjs
 * Node.js client: connects to the Bun-created ring and makes RPC calls.
 *
 * Run (after bun_server is running):
 *   node demo/node_client.mjs
 *
 * Requires the Rust N-API addon to be built:
 *   cd node-addon && cargo build --release
 */

import { createRequire } from "node:module";
import { fileURLToPath }  from "node:url";
import { join, dirname }  from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// Load the Rust N-API addon.
const addonPath = join(__dirname, "../node-addon/target/release/uipc_node.node");
const { UIPCRingHandle, MSG_CALL, MSG_REPLY, MSG_EVENT } = require(addonPath);

const RING_NAME = "/uipc_demo_ring";

console.log("Universal-IPC Bridge — Node.js Client");
console.log(`   Ring: ${RING_NAME}\n`);

// ── Minimal RPC helper (mirrors protocol/rpc.ts but in plain CJS) ─────────

class NodeRPCClient {
  #ring;
  #pending = new Map();
  #msgIdCounter = 1n;
  #poll;

  constructor(ring) {
    this.#ring = ring;
    // Start polling.
    this.#poll = setInterval(() => this.#tick(), 1);
  }

  #nextId() { return this.#msgIdCounter++; }

  call(method, args = {}, timeoutMs = 5000) {
    const payload = this.#encode({ method, ...args });
    const msgId   = this.#ring.sendCall(payload);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(msgId);
        reject(new Error(`Timeout: ${method}`));
      }, timeoutMs);
      this.#pending.set(msgId, { resolve, reject, timer });
    });
  }

  #tick() {
    let msg;
    while ((msg = this.#ring.poll()) !== null) {
      if (msg.msgType === MSG_REPLY) {
        const p = this.#pending.get(msg.correlationId);
        if (!p) continue;
        clearTimeout(p.timer);
        this.#pending.delete(msg.correlationId);
        const obj = this.#decode(msg.payload);
        if ("error" in obj) p.reject(new Error(obj.error));
        else                 p.resolve(obj.result);
      }
    }
  }

  // Tiny encode/decode matching protocol/flat_msg.ts format.
  #encode(obj) {
    const enc    = new TextEncoder();
    const fields = Object.entries(obj).filter(([, v]) => v !== undefined);
    let   total  = 1;
    const parts  = [];

    for (const [key, val] of fields) {
      const keyBytes = enc.encode(key);
      const valPart  = this.#encodeVal(val);
      const size     = 1 + 2 + keyBytes.length + 4 + valPart.length;
      total += size;

      const f    = Buffer.alloc(size);
      let   off  = 0;
      f.writeUInt8(this.#tagFor(val), off++);
      f.writeUInt16LE(keyBytes.length, off); off += 2;
      f.set(keyBytes, off); off += keyBytes.length;
      f.writeUInt32LE(valPart.length, off); off += 4;
      f.set(valPart, off);
      parts.push(f);
    }

    const out = Buffer.alloc(total);
    out.writeUInt8(fields.length, 0);
    let pos = 1;
    for (const p of parts) { p.copy(out, pos); pos += p.length; }
    return out;
  }

  #tagFor(v) {
    if (v === null || v === undefined) return 0x07;
    if (typeof v === "boolean")        return 0x04;
    if (typeof v === "bigint")         return 0x09;
    if (typeof v === "number") {
      if (Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF) return 0x01;
      return 0x03;
    }
    if (typeof v === "string")         return 0x05;
    if (v instanceof Uint8Array || Buffer.isBuffer(v)) return 0x06;
    if (Array.isArray(v)) {
      // Encode as string (JSON) for simplicity in demo.
      return 0x05;
    }
    return 0x05; // fallback: JSON string
  }

  #encodeVal(v) {
    if (v === null || v === undefined) return Buffer.alloc(0);
    if (typeof v === "boolean") { const b = Buffer.alloc(1); b[0] = v ? 1 : 0; return b; }
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF) {
      const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b;
    }
    if (typeof v === "number") {
      const b = Buffer.alloc(8); b.writeDoubleLELE?.(v, 0) ?? b.writeDoubleLE(v, 0); return b;
    }
    if (typeof v === "bigint") {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(v, 0);
      return b;
    }
    if (typeof v === "string") return Buffer.from(v, "utf8");
    if (Buffer.isBuffer(v))    return v;
    if (Array.isArray(v))      return Buffer.from(JSON.stringify(v), "utf8");
    return Buffer.from(JSON.stringify(v), "utf8");
  }

  #decode(buf) {
    const view  = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const count = view.getUint8(0);
    const out   = {};
    let   off   = 1;

    for (let i = 0; i < count; i++) {
      const tag    = view.getUint8(off++);
      const keyLen = view.getUint16(off, true); off += 2;
      const key    = new TextDecoder().decode(buf.subarray(off, off + keyLen)); off += keyLen;
      const valLen = view.getUint32(off, true); off += 4;
      const valBuf = buf.subarray(off, off + valLen); off += valLen;
      out[key]     = this.#decodeVal(tag, valBuf);
    }
    return out;
  }

  #decodeVal(tag, b) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    switch (tag) {
      case 0x07: return null;
      case 0x04: return b[0] !== 0;
      case 0x01: return v.getUint32(0, true);
      case 0x08: return v.getInt32(0, true);
      case 0x03: return v.getFloat64(0, true);
      case 0x09: return new DataView(b.buffer).getBigInt64(b.byteOffset, true);
      case 0x05: return new TextDecoder().decode(b);
      case 0x06: return Buffer.from(b);
      default:   return null;
    }
  }

  stop() { clearInterval(this.#poll); }
}

// ── Main ─────────────────────────────────────────────────────────────────

(async () => {
  const ring   = new UIPCRingHandle(RING_NAME, false);
  const client = new NodeRPCClient(ring);

  try {
    console.log("📡 Calling bun_server from Node.js...\n");

    // Ping
    const pong = await client.call("ping");
    console.log(`  ping → ${pong}`);

    // Add
    const sum = await client.call("add", { a: 40, b: 2 });
    console.log(`  add(40, 2) → ${sum}`);

    // Echo
    const echo = await client.call("echo", { message: "Hello from Node.js!" });
    console.log(`  echo → "${echo}"`);

    // Fibonacci
    const fib = await client.call("fibonacci", { n: 20 });
    console.log(`  fibonacci(20) → ${fib}`);

    // Throughput test
    console.log("\n  ⚡ Throughput test (1000 calls)...");
    const t0   = performance.now();
    const N    = 1000;
    const jobs = [];
    for (let i = 0; i < N; i++) {
      jobs.push(client.call("add", { a: i, b: i }));
    }
    await Promise.all(jobs);
    const elapsed = performance.now() - t0;
    console.log(`     ${N} round-trips in ${elapsed.toFixed(1)}ms`);
    console.log(`     = ${(N / (elapsed / 1000)).toFixed(0)} calls/sec`);

    console.log("\nNode.js client done.\n");
  } finally {
    client.stop();
    ring.close();
  }
})();
