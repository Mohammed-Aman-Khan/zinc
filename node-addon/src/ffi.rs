// node-addon/src/ffi.rs
//! Raw FFI bindings to libuipc_core (the Zig shared memory ring buffer).

use libc::{c_char, c_int};

/// Matches `UIPCHeader` in uipc.h — must be kept in sync.
#[repr(C, packed)]
#[derive(Debug, Clone, Copy, Default)]
pub struct UIPCHeader {
    pub magic:          u8,
    pub version:        u8,
    pub flags:          u16,
    pub payload_len:    u32,
    pub msg_id:         u64,
    pub correlation_id: u64,
    pub msg_type:       u8,
    pub sender_pid:     u32,
    pub _pad:           [u8; 3],
}

const _: () = assert!(std::mem::size_of::<UIPCHeader>() == 32);

/// Opaque handle returned by uipc_open.
#[repr(C)]
pub struct UIPCRing {
    _private: [u8; 0],
}

unsafe impl Send for UIPCRing {}
unsafe impl Sync for UIPCRing {}

extern "C" {
    pub fn uipc_open(name: *const c_char, create: u8) -> *mut UIPCRing;
    pub fn uipc_close(ring: *mut UIPCRing);
    pub fn uipc_unlink(ring: *mut UIPCRing);

    pub fn uipc_send(
        ring:           *mut UIPCRing,
        msg_type:       u8,
        msg_id:         u64,
        correlation_id: u64,
        payload_ptr:    *const u8,
        payload_len:    u32,
    ) -> c_int;

    pub fn uipc_poll(
        ring:             *mut UIPCRing,
        out_header:       *mut UIPCHeader,
        out_payload:      *mut u8,
        out_payload_len:  *mut u32,
    ) -> c_int;

    pub fn uipc_stats(ring: *mut UIPCRing, out_used: *mut u64, out_free: *mut u64);
    pub fn uipc_max_payload() -> u32;

    // Shared buffer API
    pub fn uipc_shm_create(name: *const c_char, size: u64) -> *mut UIPCShm;
    pub fn uipc_shm_open(name: *const c_char, size: u64) -> *mut UIPCShm;
    pub fn uipc_shm_ptr(shm: *mut UIPCShm) -> *mut u8;
    pub fn uipc_shm_size(shm: *mut UIPCShm) -> u64;
    pub fn uipc_shm_close(shm: *mut UIPCShm);
    pub fn uipc_shm_unlink(shm: *mut UIPCShm);
}

/// Opaque handle for shared memory regions.
#[repr(C)]
pub struct UIPCShm {
    _private: [u8; 0],
}

unsafe impl Send for UIPCShm {}
unsafe impl Sync for UIPCShm {}

/// Message type constants.
pub mod msg_type {
    pub const CALL:  u8 = 0x01;
    pub const REPLY: u8 = 0x02;
    pub const EVENT: u8 = 0x03;
    pub const PING:  u8 = 0x04;
    pub const PONG:  u8 = 0x05;
    pub const ERROR: u8 = 0xFF;
}
