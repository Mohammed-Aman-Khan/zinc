const std = @import("std");
const rb = @import("ring_buffer.zig");
const testing = std.testing;

test "single producer single consumer" {
    const name = "/uipc_test_spsc";
    std.posix.shm_unlink(name) catch {};

    var ring = try rb.RingBuffer.open(name, true);
    defer {
        ring.unlink();
        ring.close();
    }

    const ITERS = 10_000;

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

    const Handler = struct {
        count: u64 = 0,
        sum: u64 = 0,

        pub fn handle(self: *@This(), _: *const rb.MsgHeader, payload: []const u8) !void {
            self.count += 1;
            self.sum += std.mem.readInt(u64, payload[0..8], .little);
        }
    };

    var h = Handler{};
    while (h.count < ITERS) {
        _ = ring.recv(&h) catch {};
    }
    producer.join();

    try testing.expectEqual(@as(u64, ITERS), h.count);
    const expected_sum = ITERS * (ITERS - 1) / 2;
    try testing.expectEqual(expected_sum, h.sum);
}

test "ring full returns null" {
    const name = "/uipc_test_full";
    std.posix.shm_unlink(name) catch {};

    var ring = try rb.RingBuffer.open(name, true);
    defer {
        ring.unlink();
        ring.close();
    }

    var sent: usize = 0;
    while (sent < rb.RING_CAPACITY) {
        if (ring.claim()) |idx| {
            try ring.publish(idx, .event, sent + 1, 0, "x");
            sent += 1;
        } else break;
    }

    try testing.expectEqual(@as(?usize, null), ring.claim());
}

test "crc32 rejects tampered payload" {
    const name = "/uipc_test_crc";
    std.posix.shm_unlink(name) catch {};

    var ring = try rb.RingBuffer.open(name, true);
    defer {
        ring.unlink();
        ring.close();
    }

    try ring.send(.call, 1, 0, "legitimate payload");

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
    defer {
        ring.unlink();
        ring.close();
    }

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
    defer {
        ring.unlink();
        ring.close();
    }

    const huge = [_]u8{0} ** (rb.MAX_PAYLOAD + 1);
    const result = ring.send(.event, 1, 0, &huge);
    try testing.expectError(error.PayloadTooLarge, result);
}
