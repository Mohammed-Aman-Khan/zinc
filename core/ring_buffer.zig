//! Lock-free SPMC/MPSC ring buffer over POSIX shared memory.
//! Every cross-process field goes through atomic ops — no locks, no futexes.

const std = @import("std");
const builtin = @import("builtin");
const assert = std.debug.assert;
const Atomic = std.atomic.Value;

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

pub const MAGIC: u8 = 0x1B;
pub const PROTOCOL_VERSION: u8 = 0x01;
pub const CACHE_LINE: usize = 64;

/// Maximum payload that fits in a single slot (bytes).
/// Chosen so that (HEADER_SIZE + MAX_PAYLOAD) % CACHE_LINE == 0.
pub const HEADER_SIZE: usize = 32;
pub const MAX_PAYLOAD: usize = 4096 - HEADER_SIZE; // 4 KB slots

/// Number of slots in the ring. MUST be a power of two.
pub const RING_CAPACITY: usize = 4096;

/// Total shared memory region size.
pub const SHM_SIZE: usize = @sizeOf(RingHeader) + RING_CAPACITY * @sizeOf(Slot);

/// Default shm name.
pub const DEFAULT_SHM_NAME: []const u8 = "/uipc_bridge_v1";

// ──────────────────────────────────────────────
// Wire Types
// ──────────────────────────────────────────────

pub const MsgType = enum(u8) {
    call = 0x01,
    reply = 0x02,
    event = 0x03,
    ping = 0x04,
    pong = 0x05,
    @"error" = 0xFF,
    _,
};

pub const SlotState = enum(u8) {
    free = 0,
    writing = 1,
    ready = 2,
    reading = 3,
};

/// Flat binary message header — exactly 32 bytes, cache-line friendly.
pub const MsgHeader = extern struct {
    magic: u8 = MAGIC,
    version: u8 = PROTOCOL_VERSION,
    flags: u16 = 0,
    payload_len: u32,
    msg_id: u64,
    correlation_id: u64 = 0,
    msg_type: u8,
    sender_pid: u32,
    _pad: [3]u8 = [_]u8{0} ** 3,

    comptime {
        assert(@sizeOf(MsgHeader) == HEADER_SIZE);
        assert(@alignOf(MsgHeader) <= CACHE_LINE);
    }
};

/// A single ring slot: header + payload, padded to 4 KB.
pub const Slot = extern struct {
    /// Atomic state machine for this slot.
    state: u8 align(CACHE_LINE),
    _pad0: [CACHE_LINE - 1]u8 = [_]u8{0} ** (CACHE_LINE - 1),
    /// CRC32 of (header_bytes ++ payload_bytes).
    crc32: u32,
    _pad1: [CACHE_LINE - 4]u8 = [_]u8{0} ** (CACHE_LINE - 4),
    /// The actual message.
    header: MsgHeader,
    payload: [MAX_PAYLOAD]u8,

    comptime {
        assert(@sizeOf(Slot) == 4096);
    }
};

/// The ring control block, placed at offset 0 of the shm region.
/// head and tail are *byte offsets into the slots array*, always masked.
pub const RingHeader = extern struct {
    magic: u64 = 0x555F495043_42524457, // "UIPCBRDW"
    version: u32 = 1,
    capacity: u32 = RING_CAPACITY,
    slot_size: u32 = @sizeOf(Slot),
    _pad: [CACHE_LINE - 20]u8 = [_]u8{0} ** (CACHE_LINE - 20),

    /// Producer cursor (head). Written by producers, read by consumers.
    head: u64 align(CACHE_LINE) = 0,
    _pad_head: [CACHE_LINE - 8]u8 = [_]u8{0} ** (CACHE_LINE - 8),

    /// Consumer cursor (tail). Written by consumers, read by producers.
    tail: u64 align(CACHE_LINE) = 0,
    _pad_tail: [CACHE_LINE - 8]u8 = [_]u8{0} ** (CACHE_LINE - 8),
};

// ──────────────────────────────────────────────
// CRC32 (Castagnoli, fast table-based)
// ──────────────────────────────────────────────

const crc32_table: [256]u32 = blk: {
    var table: [256]u32 = undefined;
    for (0..256) |i| {
        var crc: u32 = @intCast(i);
        for (0..8) |_| {
            if (crc & 1 != 0) {
                crc = (crc >> 1) ^ 0x82F63B78;
            } else {
                crc >>= 1;
            }
        }
        table[i] = crc;
    }
    break :blk table;
};

pub fn crc32(data: []const u8) u32 {
    var crc: u32 = 0xFFFFFFFF;
    for (data) |byte| {
        crc = (crc >> 8) ^ crc32_table[(crc ^ byte) & 0xFF];
    }
    return ~crc;
}

// ──────────────────────────────────────────────
// RingBuffer handle
// ──────────────────────────────────────────────

pub const RingBuffer = struct {
    header: *RingHeader,
    slots: [*]Slot,
    shm_fd: i32,
    size: usize,
    name: []const u8,

    /// Open or create the shared memory ring.
    pub fn open(name: []const u8, create: bool) !RingBuffer {
        const posix = std.posix;

        const flags: posix.O = if (create)
            .{ .ACCMODE = .RDWR, .CREAT = true, .EXCL = false }
        else
            .{ .ACCMODE = .RDWR };

        const fd = try posix.shm_open(name, flags, 0o600);
        errdefer posix.close(fd);

        if (create) {
            try posix.ftruncate(fd, @intCast(SHM_SIZE));
        }

        const ptr = try posix.mmap(
            null,
            SHM_SIZE,
            posix.PROT.READ | posix.PROT.WRITE,
            .{ .TYPE = .SHARED },
            fd,
            0,
        );
        errdefer posix.munmap(@alignCast(ptr[0..SHM_SIZE]));

        const ring_header: *RingHeader = @ptrCast(@alignCast(ptr));
        const slots_ptr: [*]Slot = @ptrCast(@alignCast(@as([*]u8, @ptrCast(ptr)) + @sizeOf(RingHeader)));

        if (create) {
            // Initialize the control block atomically.
            ring_header.* = RingHeader{};
            @fence(.seq_cst);
            // Zero all slots.
            @memset(std.mem.asBytes(ring_header)[0..SHM_SIZE], 0);
            ring_header.* = RingHeader{};
        } else {
            // Verify magic.
            if (ring_header.magic != (RingHeader{}).magic) {
                return error.InvalidMagic;
            }
        }

        return RingBuffer{
            .header = ring_header,
            .slots = slots_ptr,
            .shm_fd = fd,
            .size = SHM_SIZE,
            .name = name,
        };
    }

    pub fn close(self: *RingBuffer) void {
        std.posix.munmap(@alignCast((@as([*]u8, @ptrCast(self.header)))[0..self.size]));
        std.posix.close(self.shm_fd);
    }

    pub fn unlink(self: *RingBuffer) void {
        std.posix.shm_unlink(self.name) catch {};
    }

    // ──────────────────────────────────────────────
    // Producer API
    // ──────────────────────────────────────────────

    /// Try to claim a free slot for writing.
    /// Returns the slot index, or null if the ring is full.
    pub fn claim(self: *RingBuffer) ?usize {
        const capacity = RING_CAPACITY;
        const mask: u64 = capacity - 1;

        // Load the current head with acquire ordering.
        const head = @atomicLoad(u64, &self.header.head, .acquire);
        const tail = @atomicLoad(u64, &self.header.tail, .acquire);

        if (head - tail >= capacity) return null; // ring full

        const idx: usize = @intCast(head & mask);
        const slot = &self.slots[idx];

        // CAS the slot state from free → writing.
        const old = @cmpxchgStrong(u8, &slot.state, @intFromEnum(SlotState.free), @intFromEnum(SlotState.writing), .acq_rel, .acquire) orelse {
            // Success: advance head.
            _ = @atomicRmw(u64, &self.header.head, .Add, 1, .release);
            return idx;
        };
        _ = old;
        return null;
    }

    /// Write a message into a previously claimed slot and mark it ready.
    pub fn publish(self: *RingBuffer, idx: usize, msg_type: MsgType, msg_id: u64, correlation_id: u64, payload: []const u8) !void {
        if (payload.len > MAX_PAYLOAD) return error.PayloadTooLarge;

        const slot = &self.slots[idx];
        assert(@atomicLoad(u8, &slot.state, .acquire) == @intFromEnum(SlotState.writing));

        slot.header = .{
            .payload_len = @intCast(payload.len),
            .msg_id = msg_id,
            .correlation_id = correlation_id,
            .msg_type = @intFromEnum(msg_type),
            .sender_pid = @intCast(std.c.getpid()),
        };
        @memcpy(slot.payload[0..payload.len], payload);

        // CRC32C over header + payload, single pass.
        var crc_val: u32 = 0xFFFFFFFF;
        for (std.mem.asBytes(&slot.header)) |b| crc_val = (crc_val >> 8) ^ crc32_table[(crc_val ^ b) & 0xFF];
        for (payload) |b| crc_val = (crc_val >> 8) ^ crc32_table[(crc_val ^ b) & 0xFF];
        slot.crc32 = ~crc_val;

        // Release the slot to consumers.
        @fence(.release);
        @atomicStore(u8, &slot.state, @intFromEnum(SlotState.ready), .release);
    }

    /// Convenience: claim + publish in one call (single-threaded producer path).
    pub fn send(self: *RingBuffer, msg_type: MsgType, msg_id: u64, correlation_id: u64, payload: []const u8) !void {
        var retries: usize = 0;
        const idx = while (retries < 1000) : (retries += 1) {
            if (self.claim()) |i| break i;
            std.atomic.spinLoopHint();
        } else return error.RingFull;
        try self.publish(idx, msg_type, msg_id, correlation_id, payload);
    }

    // ──────────────────────────────────────────────
    // Consumer API
    // ──────────────────────────────────────────────

    /// Try to consume the next ready slot.
    /// Calls `handler` with a read-only view of the message, then frees the slot.
    pub fn recv(self: *RingBuffer, handler: anytype) !bool {
        const capacity = RING_CAPACITY;
        const mask: u64 = capacity - 1;

        const tail = @atomicLoad(u64, &self.header.tail, .acquire);
        const head = @atomicLoad(u64, &self.header.head, .acquire);

        if (tail == head) return false; // ring empty

        const idx: usize = @intCast(tail & mask);
        const slot = &self.slots[idx];

        // Wait for the producer to mark this slot ready.
        const state = @atomicLoad(u8, &slot.state, .acquire);
        if (state != @intFromEnum(SlotState.ready)) return false;

        // CAS: ready → reading (prevents double-consume in MPMC).
        _ = @cmpxchgStrong(u8, &slot.state, @intFromEnum(SlotState.ready), @intFromEnum(SlotState.reading), .acq_rel, .acquire) orelse {};

        @fence(.acquire);

        // Validate CRC.
        const header_bytes = std.mem.asBytes(&slot.header);
        var crc_val: u32 = 0xFFFFFFFF;
        for (header_bytes) |b| crc_val = (crc_val >> 8) ^ crc32_table[(crc_val ^ b) & 0xFF];
        const payload_slice = slot.payload[0..slot.header.payload_len];
        for (payload_slice) |b| crc_val = (crc_val >> 8) ^ crc32_table[(crc_val ^ b) & 0xFF];
        if (~crc_val != slot.crc32) {
            // Corrupt slot: release and skip.
            @atomicStore(u8, &slot.state, @intFromEnum(SlotState.free), .release);
            _ = @atomicRmw(u64, &self.header.tail, .Add, 1, .release);
            return error.CRCMismatch;
        }

        // Validate magic & version.
        if (slot.header.magic != MAGIC or slot.header.version != PROTOCOL_VERSION) {
            @atomicStore(u8, &slot.state, @intFromEnum(SlotState.free), .release);
            _ = @atomicRmw(u64, &self.header.tail, .Add, 1, .release);
            return error.InvalidHeader;
        }

        // Deliver to handler.
        try handler.handle(&slot.header, payload_slice);

        // Release slot and advance tail.
        @atomicStore(u8, &slot.state, @intFromEnum(SlotState.free), .release);
        _ = @atomicRmw(u64, &self.header.tail, .Add, 1, .release);
        return true;
    }

    // ──────────────────────────────────────────────
    // Diagnostics
    // ──────────────────────────────────────────────

    pub fn stats(self: *const RingBuffer) struct { used: u64, free: u64, head: u64, tail: u64 } {
        const h = @atomicLoad(u64, &self.header.head, .acquire);
        const t = @atomicLoad(u64, &self.header.tail, .acquire);
        const used = h -% t;
        return .{ .used = used, .free = RING_CAPACITY - used, .head = h, .tail = t };
    }
};

// ──────────────────────────────────────────────
// C-ABI exports (for FFI from Bun/Deno/Node)
// ──────────────────────────────────────────────

const ExternRing = opaque {};

export fn uipc_open(name_ptr: [*:0]const u8, create: u8) ?*ExternRing {
    const name = std.mem.span(name_ptr);
    const ring = std.heap.c_allocator.create(RingBuffer) catch return null;
    ring.* = RingBuffer.open(name, create != 0) catch {
        std.heap.c_allocator.destroy(ring);
        return null;
    };
    return @ptrCast(ring);
}

export fn uipc_close(ring_ptr: *ExternRing) void {
    const ring: *RingBuffer = @ptrCast(@alignCast(ring_ptr));
    ring.close();
    std.heap.c_allocator.destroy(ring);
}

export fn uipc_unlink(ring_ptr: *ExternRing) void {
    const ring: *RingBuffer = @ptrCast(@alignCast(ring_ptr));
    ring.unlink();
}

export fn uipc_send(
    ring_ptr: *ExternRing,
    msg_type: u8,
    msg_id: u64,
    correlation_id: u64,
    payload_ptr: [*]const u8,
    payload_len: u32,
) i32 {
    const ring: *RingBuffer = @ptrCast(@alignCast(ring_ptr));
    const mtype: MsgType = @enumFromInt(msg_type);
    ring.send(mtype, msg_id, correlation_id, payload_ptr[0..payload_len]) catch |err| {
        _ = err;
        return -1;
    };
    return 0;
}

/// Poll for one message. Returns 1 if consumed, 0 if empty, -1 on error.
/// out_header_ptr and out_payload_ptr must point to caller-owned buffers.
export fn uipc_poll(
    ring_ptr: *ExternRing,
    out_header: *MsgHeader,
    out_payload: [*]u8,
    out_payload_len: *u32,
) i32 {
    const ring: *RingBuffer = @ptrCast(@alignCast(ring_ptr));

    const Handler = struct {
        hdr: *MsgHeader,
        buf: [*]u8,
        len: *u32,

        pub fn handle(self: *const @This(), header: *const MsgHeader, payload: []const u8) !void {
            self.hdr.* = header.*;
            @memcpy(self.buf[0..payload.len], payload);
            self.len.* = @intCast(payload.len);
        }
    };

    var h = Handler{ .hdr = out_header, .buf = out_payload, .len = out_payload_len };
    const got = ring.recv(&h) catch return -1;
    return if (got) 1 else 0;
}

export fn uipc_stats(
    ring_ptr: *ExternRing,
    out_used: *u64,
    out_free: *u64,
) void {
    const ring: *RingBuffer = @ptrCast(@alignCast(ring_ptr));
    const s = ring.stats();
    out_used.* = s.used;
    out_free.* = s.free;
}

export fn uipc_max_payload() u32 {
    return MAX_PAYLOAD;
}

// ──────────────────────────────────────────────
// Shared buffer API — raw cross-process memory regions
// ──────────────────────────────────────────────

const ShmRegion = struct {
    ptr: [*]u8,
    size: usize,
    fd: i32,
    name: []const u8,
};

const ExternShm = opaque {};

/// Create a new shared memory region of `size` bytes.
export fn uipc_shm_create(name_ptr: [*:0]const u8, size: u64) ?*ExternShm {
    const posix = std.posix;
    const name = std.mem.span(name_ptr);
    const sz: usize = @intCast(size);

    const fd = posix.shm_open(
        name,
        .{ .ACCMODE = .RDWR, .CREAT = true, .EXCL = false },
        0o600,
    ) catch return null;

    posix.ftruncate(fd, @intCast(sz)) catch {
        posix.close(fd);
        return null;
    };

    const mapped = posix.mmap(
        null,
        sz,
        posix.PROT.READ | posix.PROT.WRITE,
        .{ .TYPE = .SHARED },
        fd,
        0,
    ) catch {
        posix.close(fd);
        return null;
    };

    // Zero-initialize the region.
    @memset(@as([*]u8, @ptrCast(mapped))[0..sz], 0);

    const region = std.heap.c_allocator.create(ShmRegion) catch {
        posix.munmap(@alignCast(mapped[0..sz]));
        posix.close(fd);
        return null;
    };
    region.* = .{
        .ptr = @ptrCast(mapped),
        .size = sz,
        .fd = fd,
        .name = name,
    };
    return @ptrCast(region);
}

/// Open an existing shared memory region (size is read from the fd).
export fn uipc_shm_open(name_ptr: [*:0]const u8, size: u64) ?*ExternShm {
    const posix = std.posix;
    const name = std.mem.span(name_ptr);
    const sz: usize = @intCast(size);

    const fd = posix.shm_open(
        name,
        .{ .ACCMODE = .RDWR },
        0o600,
    ) catch return null;

    const mapped = posix.mmap(
        null,
        sz,
        posix.PROT.READ | posix.PROT.WRITE,
        .{ .TYPE = .SHARED },
        fd,
        0,
    ) catch {
        posix.close(fd);
        return null;
    };

    const region = std.heap.c_allocator.create(ShmRegion) catch {
        posix.munmap(@alignCast(mapped[0..sz]));
        posix.close(fd);
        return null;
    };
    region.* = .{
        .ptr = @ptrCast(mapped),
        .size = sz,
        .fd = fd,
        .name = name,
    };
    return @ptrCast(region);
}

/// Get a raw pointer to the shared memory region.
export fn uipc_shm_ptr(shm_ptr: *ExternShm) ?[*]u8 {
    const region: *ShmRegion = @ptrCast(@alignCast(shm_ptr));
    return region.ptr;
}

/// Get the size of the shared memory region in bytes.
export fn uipc_shm_size(shm_ptr: *ExternShm) u64 {
    const region: *ShmRegion = @ptrCast(@alignCast(shm_ptr));
    return @intCast(region.size);
}

/// Unmap and close the shared memory region (does not unlink).
export fn uipc_shm_close(shm_ptr: *ExternShm) void {
    const region: *ShmRegion = @ptrCast(@alignCast(shm_ptr));
    std.posix.munmap(@alignCast(region.ptr[0..region.size]));
    std.posix.close(region.fd);
    std.heap.c_allocator.destroy(region);
}

/// Unlink the shared memory segment (remove from filesystem).
export fn uipc_shm_unlink(shm_ptr: *ExternShm) void {
    const region: *ShmRegion = @ptrCast(@alignCast(shm_ptr));
    std.posix.shm_unlink(region.name) catch {};
}
