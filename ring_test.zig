/// core/ring_test.zig — unit tests for the ring buffer.
const std     = @import("std");
const rb      = @import("ring_buffer.zig");
const testing = std.testing;

/// In-process smoke test: single producer, single consumer, 10k messages.
test "single producer single consumer" {
    // Use a unique name so parallel test runs don't collide.
    const name = "/uipc_test_spsc";
    std.posix.shm_unlink(name) catch {};

    var ring = try rb.RingBuffer.open(name, true);
    defer { ring.unlink(); ring.close(); }

    const ITERS = 10_000;

    // ── Producer thread ──────────────────────────────────────────────────
    const producer = try std.Thread.spawn(.{}, struct {
        fn run(r: *rb.RingBuffer) void {
            var buf: [64]u8 = undefined;
            var i: u64 = 0;
            while (i < ITERS) : (i += 1) {
                std.mem.writeInt(u64, buf[0..8], i, .little);
                r.send(.event, i + 1, 0, buf[0..8]) catch {
                    std.atomic.spinLoopHint();
                    continue;
                };
            }
        }
    }.run, .{&ring});

    // ── Consumer (main thread) ───────────────────────────────────────────
    const Handler = struct {
        count:   u64  = 0,
        sum:     u64  = 0,

        pub fn handle(self: *@This(), _: *const rb.MsgHeader, payload: []const u8) !void {
            self.count += 1;
            self.sum   += std.mem.readInt(u64, payload[0..8], .little);
        }
    };

    var h = Handler{};
    while (h.count < ITERS) {
        _ = ring.recv(&h) catch {};
    }
    producer.join();

    // sum of 0..9999 == 49_995_000
    try testing.expectEqual(@as(u64, ITERS), h.count);
    const expected_sum = ITERS * (ITERS - 1) / 2;
    try testing.expectEqual(expected_sum, h.sum);
}

test "ring full returns null" {
    const name = "/uipc_test_full";
    std.posix.shm_unlink(name) catch {};

    var ring = try rb.RingBuffer.open(name, true);
    defer { ring.unlink(); ring.close(); }

    // Fill the ring.
    var sent: usize = 0;
    while (sent < rb.RING_CAPACITY) {
        if (ring.claim()) |idx| {
            try ring.publish(idx, .event, sent + 1, 0, "x");
            sent += 1;
        } else break;
    }

    // Next claim should return null.
    try testing.expectEqual(@as(?usize, null), ring.claim());
}

test "crc32 rejects tampered payload" {
    const name = "/uipc_test_crc";
    std.posix.shm_unlink(name) catch {};

    var ring = try rb.RingBuffer.open(name, true);
    defer { ring.unlink(); ring.close(); }

    try ring.send(.call, 1, 0, "legitimate payload");

    // Tamper with the slot.
    ring.slots[0].payload[3] ^= 0xFF;

    const Handler = struct {
        pub fn handle(_: *@This(), _: *const rb.MsgHeader, _: []const u8) !void {}
    };
    var h = Handler{};
    const result = ring.recv(&h);
    try testing.expectError(error.CRCMismatch, result);
}

test "stats reflect usage" {
    const name = "/uipc_test_stats";
    std.posix.shm_unlink(name) catch {};

    var ring = try rb.RingBuffer.open(name, true);
    defer { ring.unlink(); ring.close(); }

    const s0 = ring.stats();
    try testing.expectEqual(@as(u64, 0), s0.used);

    try ring.send(.event, 1, 0, "hello");
    try ring.send(.event, 2, 0, "world");

    const s1 = ring.stats();
    try testing.expectEqual(@as(u64, 2), s1.used);
}

test "payload size limit enforced" {
    const name = "/uipc_test_limit";
    std.posix.shm_unlink(name) catch {};

    var ring = try rb.RingBuffer.open(name, true);
    defer { ring.unlink(); ring.close(); }

    const huge = [_]u8{0} ** (rb.MAX_PAYLOAD + 1);
    const result = ring.send(.event, 1, 0, &huge);
    try testing.expectError(error.PayloadTooLarge, result);
}
