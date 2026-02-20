/**
 * tests/security.test.mjs
 * Tests for the security hardening layer.
 */

// Inline SecurityGuard (mirrors protocol/security.ts)

const DEFAULT_ALLOWED_TYPES = new Set([0x01, 0x02, 0x03, 0x04, 0x05]);

class SecurityGuard {
  #policy;
  #seenIds = new Map();
  #buckets = new Map();
  #lastRefill = new Map();

  constructor(policy = {}) {
    this.#policy = {
      maxPayloadBytes: policy.maxPayloadBytes ?? 4064,
      allowedPids: policy.allowedPids ?? new Set(),
      maxMsgPerSecPerPid: policy.maxMsgPerSecPerPid ?? 100_000,
      allowedMsgTypes: policy.allowedMsgTypes ?? DEFAULT_ALLOWED_TYPES,
      allowedMethods: policy.allowedMethods ?? new Set(),
      replayProtection: policy.replayProtection ?? true,
    };
  }

  verify(msg) {
    const payLen = msg.payload?.length ?? 0;

    // 1. Payload size
    if (payLen > this.#policy.maxPayloadBytes)
      return { allowed: false, reason: `Payload too large: ${payLen}` };

    // 2. Msg type allowlist
    if (!this.#policy.allowedMsgTypes.has(msg.msgType))
      return {
        allowed: false,
        reason: `Disallowed msg_type: 0x${msg.msgType.toString(16)}`,
      };

    // 3. PID allowlist
    if (
      this.#policy.allowedPids.size > 0 &&
      !this.#policy.allowedPids.has(msg.senderPid)
    )
      return { allowed: false, reason: `Disallowed PID: ${msg.senderPid}` };

    // 4. Rate limiting
    const now = Date.now();
    const pid = msg.senderPid;
    const lastRefill = this.#lastRefill.get(pid) ?? now;
    const elapsed = (now - lastRefill) / 1000;
    let tokens =
      (this.#buckets.get(pid) ?? this.#policy.maxMsgPerSecPerPid) +
      elapsed * this.#policy.maxMsgPerSecPerPid;
    tokens = Math.min(tokens, this.#policy.maxMsgPerSecPerPid);
    if (tokens < 1)
      return { allowed: false, reason: `Rate limit exceeded for PID ${pid}` };
    this.#buckets.set(pid, tokens - 1);
    this.#lastRefill.set(pid, now);

    // 5. Replay protection
    if (this.#policy.replayProtection && msg.senderPid !== 0) {
      const lastId = this.#seenIds.get(pid) ?? 0n;
      if (msg.msgId <= lastId)
        return {
          allowed: false,
          reason: `Replay: msgId ${msg.msgId} <= ${lastId}`,
        };
      this.#seenIds.set(pid, msg.msgId);
    }

    return { allowed: true };
  }

  verifyMethod(name) {
    if (this.#policy.allowedMethods.size === 0) return { allowed: true };
    if (!this.#policy.allowedMethods.has(name))
      return { allowed: false, reason: `Disallowed method: '${name}'` };
    return { allowed: true };
  }

  reset() {
    this.#seenIds.clear();
    this.#buckets.clear();
    this.#lastRefill.clear();
  }
}

// ── Test harness ───────────────────────────────────────────────────────────

let passed = 0,
  failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(` ${name}`);
    passed++;
  } catch (e) {
    console.log(` ${name}: ${e.message}`);
    failed++;
  }
}
function assert(cond, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}

function makeMsg(overrides = {}) {
  return {
    msgType: 0x01,
    msgId: 1n,
    correlationId: 0n,
    senderPid: 1234,
    payload: new Uint8Array(100),
    ...overrides,
  };
}

console.log("\n🔐 Security Guard Tests\n");

test("allows a normal message", () => {
  const g = new SecurityGuard();
  const v = g.verify(makeMsg());
  assert(v.allowed, v.reason);
});

test("blocks oversized payload", () => {
  const g = new SecurityGuard({ maxPayloadBytes: 100 });
  const v = g.verify(makeMsg({ payload: new Uint8Array(200) }));
  assert(!v.allowed);
  assert(v.reason.includes("too large"));
});

test("blocks disallowed msg_type", () => {
  const g = new SecurityGuard({ allowedMsgTypes: new Set([0x01, 0x02]) });
  const v = g.verify(makeMsg({ msgType: 0xaa }));
  assert(!v.allowed);
  assert(v.reason.includes("msg_type"));
});

test("allows message from allowlisted PID", () => {
  const g = new SecurityGuard({ allowedPids: new Set([1234]) });
  const v = g.verify(makeMsg({ senderPid: 1234 }));
  assert(v.allowed, v.reason);
});

test("blocks message from non-allowlisted PID", () => {
  const g = new SecurityGuard({ allowedPids: new Set([9999]) });
  const v = g.verify(makeMsg({ senderPid: 1234 }));
  assert(!v.allowed);
  assert(v.reason.includes("PID"));
});

test("replay protection: blocks same msgId twice", () => {
  const g = new SecurityGuard();
  const v1 = g.verify(makeMsg({ msgId: 5n }));
  assert(v1.allowed);
  const v2 = g.verify(makeMsg({ msgId: 5n }));
  assert(!v2.allowed);
  assert(v2.reason.includes("Replay"));
});

test("replay protection: blocks lower msgId", () => {
  const g = new SecurityGuard();
  g.verify(makeMsg({ msgId: 10n }));
  const v = g.verify(makeMsg({ msgId: 9n }));
  assert(!v.allowed);
  assert(v.reason.includes("Replay"));
});

test("replay protection: allows monotonically increasing msgIds", () => {
  const g = new SecurityGuard();
  for (let i = 1n; i <= 100n; i++) {
    const v = g.verify(makeMsg({ msgId: i }));
    assert(v.allowed, `Failed at msgId=${i}: ${v.reason}`);
  }
});

test("replay protection: PID 0 skips monotonicity check", () => {
  const g = new SecurityGuard();
  const v1 = g.verify(makeMsg({ senderPid: 0, msgId: 5n }));
  assert(v1.allowed);
  const v2 = g.verify(makeMsg({ senderPid: 0, msgId: 5n }));
  assert(v2.allowed, "PID 0 should skip replay check");
});

test("different PIDs have independent replay state", () => {
  const g = new SecurityGuard();
  g.verify(makeMsg({ senderPid: 1000, msgId: 10n }));
  g.verify(makeMsg({ senderPid: 2000, msgId: 10n }));
  // Both see 10n as their own last — next can be 11n each
  const v1 = g.verify(makeMsg({ senderPid: 1000, msgId: 11n }));
  const v2 = g.verify(makeMsg({ senderPid: 2000, msgId: 11n }));
  assert(v1.allowed, `PID 1000: ${v1.reason}`);
  assert(v2.allowed, `PID 2000: ${v2.reason}`);
});

test("method allowlist: blocks disallowed method", () => {
  const g = new SecurityGuard({ allowedMethods: new Set(["ping", "add"]) });
  const vOk = g.verifyMethod("ping");
  const vBad = g.verifyMethod("exec");
  assert(vOk.allowed);
  assert(!vBad.allowed);
  assert(vBad.reason.includes("exec"));
});

test("method allowlist: empty set = allow all", () => {
  const g = new SecurityGuard({ allowedMethods: new Set() });
  assert(g.verifyMethod("anything").allowed);
  assert(g.verifyMethod("__proto__").allowed);
});

test("rate limiting: exhausts budget then blocks", () => {
  const g = new SecurityGuard({ maxMsgPerSecPerPid: 5 });
  // Send 5 messages (should all pass)
  for (let i = 0; i < 5; i++) {
    const v = g.verify(makeMsg({ senderPid: 42, msgId: BigInt(i + 1) }));
    assert(v.allowed, `msg ${i}: ${v.reason}`);
  }
  // 6th should be rate-limited
  const vOver = g.verify(makeMsg({ senderPid: 42, msgId: 6n }));
  assert(!vOver.allowed);
  assert(vOver.reason.includes("Rate limit"));
});

test("reset clears all state", () => {
  const g = new SecurityGuard({ maxMsgPerSecPerPid: 1 });
  g.verify(makeMsg({ msgId: 1n })); // consume budget
  g.verify(makeMsg({ msgId: 2n })); // consume budget
  g.reset();
  // After reset, budget refills and seqIds clear
  const v = g.verify(makeMsg({ msgId: 1n })); // msgId 1 again (seqIds reset)
  assert(v.allowed, `After reset: ${v.reason}`);
});

test("disables replay protection when flag=false", () => {
  const g = new SecurityGuard({ replayProtection: false });
  g.verify(makeMsg({ msgId: 5n }));
  const v = g.verify(makeMsg({ msgId: 5n }));
  assert(
    v.allowed,
    "Should allow repeat msgId when replay protection disabled",
  );
});

// ── Edge cases ─────────────────────────────────────────────────────────────

test("zero-byte payload allowed", () => {
  const g = new SecurityGuard();
  assert(g.verify(makeMsg({ payload: new Uint8Array(0) })).allowed);
});

test("exactly-at-limit payload allowed", () => {
  const g = new SecurityGuard({ maxPayloadBytes: 64 });
  assert(g.verify(makeMsg({ payload: new Uint8Array(64) })).allowed);
});

test("one-over-limit payload blocked", () => {
  const g = new SecurityGuard({ maxPayloadBytes: 64 });
  assert(!g.verify(makeMsg({ payload: new Uint8Array(65) })).allowed);
});

// ── Throughput of the security guard itself ────────────────────────────────

console.log("\n⚡ Security guard throughput...");
const guard = new SecurityGuard();
const ITERS = 200_000;
const t0 = performance.now();
for (let i = 0; i < ITERS; i++) {
  guard.verify(
    makeMsg({
      senderPid: i % 100,
      msgId: BigInt(Math.floor(i / 100) * 100 + (i % 100) + 1),
    }),
  );
}
const elapsed = performance.now() - t0;
console.log(
  `   ${ITERS.toLocaleString()} verifications in ${elapsed.toFixed(1)}ms`,
);
console.log(
  `   = ${(ITERS / (elapsed / 1000) / 1e6).toFixed(2)}M verifications/sec`,
);
console.log(`   = ${((elapsed / ITERS) * 1e6).toFixed(0)}ns per check`);

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
