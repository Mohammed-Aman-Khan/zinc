/**
 * protocol/flat_msg.ts
 * Zero-copy, schema-free binary serialization for Universal-IPC Bridge.
 *
 * Wire layout (little-endian, no alignment padding):
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ u8  field_count                                            │
 *   │ ┌──────────────────────────────────────────────────────┐   │
 *   │ │ u8  type_tag                                         │   │
 *   │ │ u16 key_len                                          │   │
 *   │ │ u8  key_bytes[key_len]                               │   │
 *   │ │ u32 value_len                                        │   │
 *   │ │ u8  value_bytes[value_len]                           │   │
 *   │ └──────────────────────────────────────────────────────┘   │
 *   │  ... repeated field_count times                            │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Type tags:
 *   0x01  u32     (4 bytes LE)
 *   0x02  u64     (8 bytes LE — stored as two u32)
 *   0x03  f64     (8 bytes LE IEEE-754)
 *   0x04  bool    (1 byte: 0 or 1)
 *   0x05  string  (UTF-8 bytes, no null terminator)
 *   0x06  bytes   (raw binary)
 *   0x07  null
 *   0x08  i32     (4 bytes LE two's complement)
 *   0x09  i64     (8 bytes LE two's complement)
 */

export type FlatValue =
  | { type: "u32";    value: number  }
  | { type: "u64";    value: bigint  }
  | { type: "f64";    value: number  }
  | { type: "bool";   value: boolean }
  | { type: "string"; value: string  }
  | { type: "bytes";  value: Uint8Array }
  | { type: "null"                   }
  | { type: "i32";    value: number  }
  | { type: "i64";    value: bigint  };

export type FlatMsg = Record<string, FlatValue>;

const TAG = {
  u32:    0x01,
  u64:    0x02,
  f64:    0x03,
  bool:   0x04,
  string: 0x05,
  bytes:  0x06,
  null:   0x07,
  i32:    0x08,
  i64:    0x09,
} as const;

const ENC = new TextEncoder();
const DEC = new TextDecoder();

// ── Encoder ────────────────────────────────────────────────────────────────

export function encode(msg: FlatMsg): Uint8Array {
  const fields = Object.entries(msg);

  // ── First pass: compute total wire size (no allocations) ──────────────
  let total = 1; // field_count byte
  const keyBufs: Uint8Array[]  = new Array(fields.length);
  const valBufs: Uint8Array[]  = new Array(fields.length);

  for (let i = 0; i < fields.length; i++) {
    const [key, val] = fields[i]!;
    const kb = ENC.encode(key);
    if (kb.length > 0xFFFF) throw new Error(`Key too long: ${key}`);
    const vb = encodeValue(val);
    keyBufs[i] = kb;
    valBufs[i] = vb;
    total += 1 + 2 + kb.length + 4 + vb.length;
  }

  // ── Second pass: write into a single allocation ────────────────────────
  const out  = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out[0]     = fields.length & 0xFF;
  let pos    = 1;

  for (let i = 0; i < fields.length; i++) {
    const [, val] = fields[i]!;
    const kb      = keyBufs[i]!;
    const vb      = valBufs[i]!;

    view.setUint8(pos++, tagFor(val));
    view.setUint16(pos, kb.length, true); pos += 2;
    out.set(kb, pos);                     pos += kb.length;
    view.setUint32(pos, vb.length, true); pos += 4;
    out.set(vb, pos);                     pos += vb.length;
  }

  return out;
}

function tagFor(v: FlatValue): number {
  return TAG[v.type as keyof typeof TAG];
}

function encodeValue(v: FlatValue): Uint8Array {
  switch (v.type) {
    case "null":   return new Uint8Array(0);
    case "bool": { const b = new Uint8Array(1); b[0] = v.value ? 1 : 0; return b; }
    case "u32":  { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v.value, true); return b; }
    case "i32":  { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v.value, true); return b; }
    case "f64":  { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v.value, true); return b; }
    case "u64":  {
      const b = new Uint8Array(8);
      const view = new DataView(b.buffer);
      view.setUint32(0, Number(v.value & 0xFFFFFFFFn), true);
      view.setUint32(4, Number(v.value >> 32n), true);
      return b;
    }
    case "i64":  {
      const b = new Uint8Array(8);
      const view = new DataView(b.buffer);
      const big  = BigInt.asIntN(64, v.value);
      view.setUint32(0, Number(BigInt.asUintN(32, big)), true);
      view.setUint32(4, Number(BigInt.asUintN(32, big >> 32n)), true);
      return b;
    }
    case "string": return ENC.encode(v.value);
    case "bytes":  return v.value;
  }
}

// ── Decoder ────────────────────────────────────────────────────────────────

export function decode(buf: Uint8Array): FlatMsg {
  const view    = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count   = view.getUint8(0);
  const msg: FlatMsg = {};
  let   off     = 1;

  for (let i = 0; i < count; i++) {
    const tag     = view.getUint8(off++);
    const keyLen  = view.getUint16(off, true); off += 2;
    const key     = DEC.decode(buf.subarray(off, off + keyLen)); off += keyLen;
    const valLen  = view.getUint32(off, true); off += 4;
    const valBytes = buf.subarray(off, off + valLen); off += valLen;

    msg[key] = decodeValue(tag, valBytes);
  }

  return msg;
}

function decodeValue(tag: number, b: Uint8Array): FlatValue {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (tag) {
    case TAG.null:   return { type: "null" };
    case TAG.bool:   return { type: "bool",   value: b[0] !== 0 };
    case TAG.u32:    return { type: "u32",    value: view.getUint32(0, true) };
    case TAG.i32:    return { type: "i32",    value: view.getInt32(0, true) };
    case TAG.f64:    return { type: "f64",    value: view.getFloat64(0, true) };
    case TAG.u64: {
      const lo = BigInt(view.getUint32(0, true));
      const hi = BigInt(view.getUint32(4, true));
      return { type: "u64", value: (hi << 32n) | lo };
    }
    case TAG.i64: {
      const lo = BigInt(view.getUint32(0, true));
      const hi = BigInt(view.getInt32(4, true));        // signed upper
      return { type: "i64", value: (hi << 32n) | lo };
    }
    case TAG.string: return { type: "string", value: new TextDecoder().decode(b) };
    case TAG.bytes:  return { type: "bytes",  value: b.slice() };
    default:         throw new Error(`Unknown type tag: 0x${tag.toString(16)}`);
  }
}

// ── Convenience helpers ────────────────────────────────────────────────────

export const v = {
  u32:    (value: number):    FlatValue => ({ type: "u32", value }),
  u64:    (value: bigint):    FlatValue => ({ type: "u64", value }),
  i32:    (value: number):    FlatValue => ({ type: "i32", value }),
  i64:    (value: bigint):    FlatValue => ({ type: "i64", value }),
  f64:    (value: number):    FlatValue => ({ type: "f64", value }),
  bool:   (value: boolean):   FlatValue => ({ type: "bool", value }),
  str:    (value: string):    FlatValue => ({ type: "string", value }),
  bytes:  (value: Uint8Array):FlatValue => ({ type: "bytes", value }),
  null:   ():                 FlatValue => ({ type: "null" }),
};

/** Encode a simple JS object using type inference. */
export function encodeAuto(obj: Record<string, unknown>): Uint8Array {
  const msg: FlatMsg = {};
  for (const [k, val] of Object.entries(obj)) {
    if      (val === null || val === undefined) msg[k] = v.null();
    else if (typeof val === "boolean")          msg[k] = v.bool(val);
    else if (typeof val === "bigint")           msg[k] = v.i64(val);
    else if (typeof val === "number") {
      if (Number.isInteger(val) && val >= 0 && val <= 0xFFFFFFFF) msg[k] = v.u32(val);
      else msg[k] = v.f64(val);
    }
    else if (typeof val === "string")           msg[k] = v.str(val);
    else if (val instanceof Uint8Array)         msg[k] = v.bytes(val);
    else throw new Error(`Cannot auto-encode type ${typeof val} for key '${k}'`);
  }
  return encode(msg);
}

/** Decode to a plain JS object (loses type precision for numerics). */
export function decodeAuto(buf: Uint8Array): Record<string, unknown> {
  const msg  = decode(buf);
  const out: Record<string, unknown> = {};
  for (const [k, fv] of Object.entries(msg)) {
    switch (fv.type) {
      case "null":   out[k] = null; break;
      case "bool":   out[k] = fv.value; break;
      case "u32":
      case "i32":
      case "f64":    out[k] = fv.value; break;
      case "u64":
      case "i64":    out[k] = fv.value; break;
      case "string": out[k] = fv.value; break;
      case "bytes":  out[k] = fv.value; break;
    }
  }
  return out;
}
