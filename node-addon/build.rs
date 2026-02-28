// node-addon/build.rs
fn main() {
    napi_build::setup();

    // Link the Zig-compiled static core library.
    // During development we expect it at ../core/zig-out/lib/libuipc_core_static.a
    // In CI / release the build script copies it to OUT_DIR.
    let core_lib = std::env::var("UIPC_CORE_LIB")
        .unwrap_or_else(|_| "../core/zig-out/lib".to_string());

    println!("cargo:rustc-link-search=native={core_lib}");
    println!("cargo:rustc-link-lib=static=uipc_core_static");
    println!("cargo:rustc-link-lib=c");
    println!("cargo:rerun-if-env-changed=UIPC_CORE_LIB");
    println!("cargo:rerun-if-changed=../core/ring_buffer.zig");
}
