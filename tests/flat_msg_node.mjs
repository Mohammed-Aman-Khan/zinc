/**
 * tests/flat_msg_node.mjs
 * Node.js-compatible FlatMsg encode/decode tests (no Bun-specific APIs).
 * Run with: node --input-type=module < tests/flat_msg_node.mjs
 *        or: node tests/flat_msg_node.mjs
 *
 * Mirrors the logic of protocol/flat_msg.ts as plain ESM.
 */

// ── Inline FlatMsg implementation (mirrors protocol/flat_msg.ts) ─────────────

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

function tagFor(v) {
  return TAG[v.type];
}

function encodeValue(v) {
  switch (v.type) {
    case "null":
      return new Uint8Array(0);
    case "bool": {
      const b = new Uint8Array(1);
      b[0] = v.value ? 1 : 0;
      return b;
    }
    case "u32": {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, v.value, true);
      return b;
    }
    case "i32": {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setInt32(0, v.value, true);
      return b;
    }
    case "f64": {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, v.value, true);
      return b;
    }
    case "u64": {
      const b = new Uint8Array(8);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, Number(v.value & 0xffffffffn), true);
      dv.setUint32(4, Number(v.value >> 32n), true);
      return b;
    }
    case "i64": {
      const b = new Uint8Array(8);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, Number(BigInt.asUintN(32, v.value)), true);
      dv.setUint32(4, Number(BigInt.asUintN(32, v.value >> 32n)), true);
      return b;
    }
    case "string":
      return ENC.encode(v.value);
    case "bytes":
      return v.value;
  }
}

function encode(msg) {
  const fields = Object.entries(msg);
  const kbs = new Array(fields.length),
    vbs = new Array(fields.length);
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
    dv.setUint8(pos++, tagFor(fields[i][1]));
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
    default:
      throw new Error(`Unknown tag: 0x${tag.toString(16)}`);
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

const v = {
  u32: (value) => ({ type: "u32", value }),
  u64: (value) => ({ type: "u64", value }),
  i32: (value) => ({ type: "i32", value }),
  i64: (value) => ({ type: "i64", value }),
  f64: (value) => ({ type: "f64", value }),
  bool: (value) => ({ type: "bool", value }),
  str: (value) => ({ type: "string", value }),
  bytes: (value) => ({ type: "bytes", value }),
  null: () => ({ type: "null" }),
};

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0,
  failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}
function eq(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log("\n📦 FlatMsg encode/decode tests (Node.js)\n");

test("u32 roundtrip", () => {
  const d = decode(encode({ x: v.u32(42) }));
  eq(d.x, { type: "u32", value: 42 });
});

test("i32 negative roundtrip", () => {
  const d = decode(encode({ t: v.i32(-273) }));
  eq(d.t, { type: "i32", value: -273 });
});

test("u64 roundtrip", () => {
  const big = 9_007_199_254_740_993n;
  const d = decode(encode({ id: v.u64(big) }));
  if (d.id.value !== big) throw new Error(`got ${d.id.value}`);
});

test("i64 negative roundtrip", () => {
  const d = decode(encode({ n: v.i64(-8n) }));
  if (d.n.value !== -8n) throw new Error(`got ${d.n.value}`);
});

test("f64 roundtrip", () => {
  const d = decode(encode({ pi: v.f64(3.14159265358979) }));
  if (Math.abs(d.pi.value - 3.14159265358979) > 1e-10)
    throw new Error(`got ${d.pi.value}`);
});

test("bool true/false", () => {
  const d = decode(encode({ ok: v.bool(true), fail: v.bool(false) }));
  eq(d.ok, { type: "bool", value: true });
  eq(d.fail, { type: "bool", value: false });
});

test("string unicode", () => {
  const d = decode(encode({ g: v.str("Hello, 世界! 🌍") }));
  eq(d.g, { type: "string", value: "Hello, 世界! 🌍" });
});

test("bytes roundtrip", () => {
  const bytes = new Uint8Array([1, 2, 3, 255, 0]);
  const d = decode(encode({ data: v.bytes(bytes) }));
  if (!d.data.value.every((b, i) => b === bytes[i]))
    throw new Error("bytes mismatch");
});

test("null roundtrip", () => {
  const d = decode(encode({ nothing: v.null() }));
  eq(d.nothing, { type: "null" });
});

test("many fields", () => {
  const msg = {
    a: v.u32(1),
    b: v.str("two"),
    c: v.bool(true),
    d: v.f64(4.0),
    e: v.null(),
  };
  const d = decode(encode(msg));
  if (Object.keys(d).length !== 5)
    throw new Error(`expected 5 fields, got ${Object.keys(d).length}`);
  eq(d.a, { type: "u32", value: 1 });
});

test("empty message", () => {
  const d = decode(encode({}));
  if (Object.keys(d).length !== 0) throw new Error("expected empty");
});

test("200 fields (uint8 field_count max is 255)", () => {
  // The protocol stores field_count as uint8, so max is 255 fields.
  const msg = {};
  for (let i = 0; i < 200; i++) msg[`f${i}`] = v.u32(i);
  const d = decode(encode(msg));
  if (Object.keys(d).length !== 200)
    throw new Error(`field count wrong: ${Object.keys(d).length}`);
  if (d.f199.value !== 199) throw new Error(`f199=${d.f199.value}`);
});

// ── Throughput bench ──────────────────────────────────────────────────────────

console.log("\n⚡ Serialization throughput...");
const benchMsg = {
  method: v.str("add"),
  a: v.u32(40),
  b: v.u32(2),
  flag: v.bool(true),
};
const ITERS = 500_000;
const t0 = performance.now();
let enc;
for (let i = 0; i < ITERS; i++) enc = encode(benchMsg);
const encMs = performance.now() - t0;

const t1 = performance.now();
for (let i = 0; i < ITERS; i++) decode(enc);
const decMs = performance.now() - t1;

console.log(
  `   Encode: ${ITERS.toLocaleString()} in ${encMs.toFixed(1)}ms → ${(ITERS / (encMs / 1000) / 1e6).toFixed(2)}M/sec`,
);
console.log(
  `   Decode: ${ITERS.toLocaleString()} in ${decMs.toFixed(1)}ms → ${(ITERS / (decMs / 1000) / 1e6).toFixed(2)}M/sec`,
);
console.log(`   Wire size: ${enc.length} bytes`);

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
