/// core/bench.zig — micro-benchmark: producer/consumer throughput
const std = @import("std");
const rb  = @import("ring_buffer.zig");

const ITERS: u64 = 1_000_000;
const SHM_NAME = "/uipc_bench_tmp";

pub fn main() !void {
    // Clean up any leftover segment.
    std.posix.shm_unlink(SHM_NAME) catch {};

    var ring = try rb.RingBuffer.open(SHM_NAME, true);
    defer {
        ring.unlink();
        ring.close();
    }

    var buf: [256]u8 = undefined;
    @memset(&buf, 0xAB);

    // ── Producer thread ──────────────────────────────────────────────────
    const producer = try std.Thread.spawn(.{}, struct {
        fn run(r: *rb.RingBuffer) void {
            var id: u64 = 1;
            var sent: u64 = 0;
            while (sent < ITERS) {
                r.send(.event, id, 0, buf[0..128]) catch {
                    std.atomic.spinLoopHint();
                    continue;
                };
                id += 1;
                sent += 1;
            }
        }
    }.run, .{&ring});

    // ── Consumer (main thread) ───────────────────────────────────────────
    const Handler = struct {
        count: u64 = 0,

        pub fn handle(self: *@This(), _: *const rb.MsgHeader, _: []const u8) !void {
            self.count += 1;
        }
    };

    var handler = Handler{};
    const t0 = std.time.nanoTimestamp();
    while (handler.count < ITERS) {
        _ = ring.recv(&handler) catch {};
    }
    const t1 = std.time.nanoTimestamp();

    producer.join();

    const ns   = @as(u64, @intCast(t1 - t0));
    const per  = ns / ITERS;
    const mps  = ITERS * 1_000_000_000 / ns;

    std.debug.print(
        \\
        \\  ╔══════════════════════════════════╗
        \\  ║   Universal-IPC Bench Results   ║
        \\  ╠══════════════════════════════════╣
        \\  ║  Messages     : {d:>12}     ║
        \\  ║  Total ns     : {d:>12}     ║
        \\  ║  ns/msg       : {d:>12}     ║
        \\  ║  msg/sec      : {d:>12}     ║
        \\  ╚══════════════════════════════════╝
        \\
    ,
        .{ ITERS, ns, per, mps },
    );
}
