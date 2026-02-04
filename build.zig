const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const lib = b.addSharedLibrary(.{
        .name = "uipc_core",
        .root_source_file = b.path("ring_buffer.zig"),
        .target = target,
        .optimize = optimize,
        .version = .{ .major = 1, .minor = 0, .patch = 0 },
    });
    lib.linkLibC();

    lib.installHeader(b.path("uipc.h"), "uipc.h");

    b.installArtifact(lib);

    const static_lib = b.addStaticLibrary(.{
        .name = "uipc_core_static",
        .root_source_file = b.path("ring_buffer.zig"),
        .target = target,
        .optimize = optimize,
    });
    static_lib.linkLibC();
    b.installArtifact(static_lib);

    const bench = b.addExecutable(.{
        .name = "uipc_bench",
        .root_source_file = b.path("bench.zig"),
        .target = target,
        .optimize = .ReleaseFast,
    });
    bench.linkLibC();
    bench.root_module.addImport("ring_buffer", &lib.root_module);
    b.installArtifact(bench);

    const unit_tests = b.addTest(.{
        .root_source_file = b.path("ring_buffer.zig"),
        .target = target,
        .optimize = optimize,
    });
    unit_tests.linkLibC();

    const run_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);
}
