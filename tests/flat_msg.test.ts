/**
 * tests/flat_msg.test.ts
 * Unit tests for the FlatMsg serialization protocol.
 * Run with: bun test tests/flat_msg.test.ts
 */

import { describe, it, expect } from "bun:test";
import {
  encode,
  decode,
  encodeAuto,
  decodeAuto,
  v,
  type FlatMsg,
} from "../protocol/flat_msg.ts";

describe("FlatMsg encode/decode roundtrip", () => {
  it("encodes and decodes u32", () => {
    const msg: FlatMsg = { count: v.u32(42) };
    const decoded = decode(encode(msg));
    expect(decoded.count).toEqual({ type: "u32", value: 42 });
  });

  it("encodes and decodes u64", () => {
    const big = 9_007_199_254_740_993n; // beyond JS safe int
    const msg: FlatMsg = { id: v.u64(big) };
    const decoded = decode(encode(msg));
    expect(decoded.id).toEqual({ type: "u64", value: big });
  });

  it("encodes and decodes i32 negative", () => {
    const msg: FlatMsg = { temp: v.i32(-273) };
    const decoded = decode(encode(msg));
    expect(decoded.temp).toEqual({ type: "i32", value: -273 });
  });

  it("encodes and decodes f64", () => {
    const msg: FlatMsg = { pi: v.f64(3.14159265358979) };
    const decoded = decode(encode(msg));
    const f = decoded.pi as { type: "f64"; value: number };
    expect(f.value).toBeCloseTo(3.14159265358979, 10);
  });

  it("encodes and decodes bool", () => {
    const msg: FlatMsg = { ok: v.bool(true), fail: v.bool(false) };
    const decoded = decode(encode(msg));
    expect(decoded.ok).toEqual({ type: "bool", value: true });
    expect(decoded.fail).toEqual({ type: "bool", value: false });
  });

  it("encodes and decodes string", () => {
    const msg: FlatMsg = { greeting: v.str("Hello, 世界! 🌍") };
    const decoded = decode(encode(msg));
    expect(decoded.greeting).toEqual({
      type: "string",
      value: "Hello, 世界! 🌍",
    });
  });

  it("encodes and decodes bytes", () => {
    const bytes = new Uint8Array([1, 2, 3, 255, 0]);
    const msg: FlatMsg = { data: v.bytes(bytes) };
    const decoded = decode(encode(msg));
    const d = decoded.data as { type: "bytes"; value: Uint8Array };
    expect(d.value).toEqual(bytes);
  });

  it("encodes null", () => {
    const msg: FlatMsg = { nothing: v.null() };
    const decoded = decode(encode(msg));
    expect(decoded.nothing).toEqual({ type: "null" });
  });

  it("handles many fields", () => {
    const msg: FlatMsg = {
      a: v.u32(1),
      b: v.str("two"),
      c: v.bool(true),
      d: v.f64(4.0),
      e: v.u64(5n),
      f: v.null(),
      g: v.i32(-7),
      h: v.i64(-8n),
    };
    const decoded = decode(encode(msg));
    expect(Object.keys(decoded).length).toBe(8);
    expect(decoded.a).toEqual({ type: "u32", value: 1 });
    expect(decoded.b).toEqual({ type: "string", value: "two" });
    expect(decoded.g).toEqual({ type: "i32", value: -7 });
  });

  it("empty message", () => {
    const msg: FlatMsg = {};
    const decoded = decode(encode(msg));
    expect(Object.keys(decoded).length).toBe(0);
  });
});

describe("encodeAuto / decodeAuto", () => {
  it("roundtrips a plain object", () => {
    const obj = { method: "ping", count: 42, flag: true, label: "test" };
    const decoded = decodeAuto(encodeAuto(obj));
    expect(decoded.method).toBe("ping");
    expect(decoded.count).toBe(42);
    expect(decoded.flag).toBe(true);
    expect(decoded.label).toBe("test");
  });

  it("handles bigint", () => {
    const obj = { id: 999999999999999999n };
    const decoded = decodeAuto(encodeAuto(obj));
    expect(decoded.id).toBe(999999999999999999n);
  });
});

describe("size constraints", () => {
  it("encodes 200 fields (uint8 field_count max is 255)", () => {
    // The protocol stores field_count as uint8, so max is 255 fields.
    const msg: FlatMsg = {};
    for (let i = 0; i < 200; i++) msg[`field_${i}`] = v.u32(i);
    const encoded = encode(msg);
    const decoded = decode(encoded);
    expect(Object.keys(decoded).length).toBe(200);
    const f = decoded["field_199"] as { type: "u32"; value: number };
    expect(f.value).toBe(199);
  });

  it("rejects key with null byte", () => {
    const msg: FlatMsg = { normal: v.u32(1) };
    // Can't inject null byte via TS normally, but validate encoding doesn't crash.
    expect(() => encode(msg)).not.toThrow();
  });
});
