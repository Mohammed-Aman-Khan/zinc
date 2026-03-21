// node-addon/src/lib.rs
//! Universal-IPC Bridge — Node.js N-API addon.
//!
//! Exposes a JS class `UIPCRing` that wraps the Zig ring buffer via FFI.
//! All hot-path operations (send / poll) are synchronous to avoid event-loop
//! overhead; async variants are provided for blocking wait patterns.

#![deny(clippy::all)]
#![allow(clippy::missing_safety_doc)]

mod ffi;

use std::{
    ffi::CString,
    ptr::NonNull,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use napi::{
    bindgen_prelude::*,
    threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode},
    CallContext, Env, JsBuffer, JsNumber, JsObject, JsString, JsUndefined, JsUnknown, Result,
};
use napi_derive::napi;

use ffi::msg_type;

// ── Shared ring state ──────────────────────────────────────────────────────

struct RingState {
    ptr:        NonNull<ffi::UIPCRing>,
    msg_id:     AtomicU64,
    max_payload: usize,
}

// SAFETY: UIPCRing is safe to send across threads; all mutations go through
// atomic operations and the lock-free ring protocol.
unsafe impl Send for RingState {}
unsafe impl Sync for RingState {}

impl Drop for RingState {
    fn drop(&mut self) {
        unsafe { ffi::uipc_close(self.ptr.as_ptr()) };
    }
}

// ── JS class: UIPCRing ─────────────────────────────────────────────────────

#[napi]
pub struct UIPCRingHandle {
    inner: Arc<RingState>,
}

#[napi]
impl UIPCRingHandle {
    /// `new UIPCRing(name: string, create: boolean)`
    #[napi(constructor)]
    pub fn new(name: String, create: bool) -> Result<Self> {
        let c_name = CString::new(name.clone())
            .map_err(|_| Error::from_reason("Invalid shm name: contains null byte"))?;

        let ptr = unsafe { ffi::uipc_open(c_name.as_ptr(), create as u8) };

        let nn = NonNull::new(ptr)
            .ok_or_else(|| Error::from_reason(format!("Failed to open ring '{name}'")))?;

        let max_payload = unsafe { ffi::uipc_max_payload() } as usize;

        Ok(Self {
            inner: Arc::new(RingState {
                ptr:         nn,
                msg_id:      AtomicU64::new(1),
                max_payload,
            }),
        })
    }

    // ── Producer ────────────────────────────────────────────────────────

    /// `send(msgType: number, payload: Buffer, correlationId?: bigint): void`
    #[napi]
    pub fn send(
        &self,
        msg_type: u8,
        payload: Buffer,
        correlation_id: Option<BigInt>,
    ) -> Result<()> {
        let id = self.inner.msg_id.fetch_add(1, Ordering::Relaxed);
        let corr = correlation_id
            .and_then(|b| b.get_u64().ok().map(|(_, v, _)| v))
            .unwrap_or(0);

        let rc = unsafe {
            ffi::uipc_send(
                self.inner.ptr.as_ptr(),
                msg_type,
                id,
                corr,
                payload.as_ptr(),
                payload.len() as u32,
            )
        };

        if rc != 0 {
            return Err(Error::from_reason("Ring full or send failed"));
        }
        Ok(())
    }

    /// `sendCall(payload: Buffer, correlationId?: bigint): bigint`
    /// Returns the msg_id so the caller can correlate the reply.
    #[napi]
    pub fn send_call(&self, payload: Buffer, env: Env) -> Result<JsUnknown> {
        let id = self.inner.msg_id.fetch_add(1, Ordering::Relaxed);

        let rc = unsafe {
            ffi::uipc_send(
                self.inner.ptr.as_ptr(),
                msg_type::CALL,
                id,
                0,
                payload.as_ptr(),
                payload.len() as u32,
            )
        };

        if rc != 0 {
            return Err(Error::from_reason("Ring full or send failed"));
        }

        env.create_bigint_from_u64(id)
            .map(|b| b.into_unknown())
    }

    /// Fire-and-forget event.
    #[napi]
    pub fn emit(&self, payload: Buffer) -> Result<()> {
        let id = self.inner.msg_id.fetch_add(1, Ordering::Relaxed);
        let rc = unsafe {
            ffi::uipc_send(
                self.inner.ptr.as_ptr(),
                msg_type::EVENT,
                id,
                0,
                payload.as_ptr(),
                payload.len() as u32,
            )
        };
        if rc != 0 {
            Err(Error::from_reason("Ring full"))
        } else {
            Ok(())
        }
    }

    // ── Consumer ────────────────────────────────────────────────────────

    /// Non-blocking poll. Returns null if empty, else `{header, payload}`.
    #[napi]
    pub fn poll(&self, env: Env) -> Result<JsUnknown> {
        let mut header = ffi::UIPCHeader::default();
        let max_payload = self.inner.max_payload;
        let mut payload_buf = vec![0u8; max_payload];
        let mut payload_len: u32 = 0;

        let rc = unsafe {
            ffi::uipc_poll(
                self.inner.ptr.as_ptr(),
                &mut header,
                payload_buf.as_mut_ptr(),
                &mut payload_len,
            )
        };

        match rc {
            1 => {
                // Build JS object { msgType, msgId, correlationId, senderPid, payload }
                let mut obj = env.create_object()?;

                obj.set_named_property("msgType",       env.create_uint32(header.msg_type as u32)?)?;
                obj.set_named_property("msgId",         env.create_bigint_from_u64(header.msg_id)?.into_unknown())?;
                obj.set_named_property("correlationId", env.create_bigint_from_u64(header.correlation_id)?.into_unknown())?;
                obj.set_named_property("senderPid",     env.create_uint32(header.sender_pid as u32)?)?;

                let len = payload_len as usize;
                payload_buf.truncate(len);
                let jsbuf = env.create_buffer_with_data(payload_buf)?;
                obj.set_named_property("payload", jsbuf.into_raw())?;

                Ok(obj.into_unknown())
            }
            0 => env.get_null().map(|v| v.into_unknown()),
            _ => Err(Error::from_reason("Ring error or CRC mismatch")),
        }
    }

    /// Async drain: polls until empty, collecting all messages.
    /// Returns Array<{msgType, msgId, ...}>.
    #[napi]
    pub fn drain(&self, env: Env) -> Result<JsUnknown> {
        let mut results: Vec<JsUnknown> = Vec::new();

        loop {
            let msg = self.poll(env)?;
            // Check if null.
            if matches!(msg.get_type()?, ValueType::Null) {
                break;
            }
            results.push(msg);
        }

        let mut arr = env.create_array(results.len() as u32)?;
        for (i, item) in results.into_iter().enumerate() {
            arr.set_element(i as u32, item)?;
        }
        Ok(arr.into_unknown())
    }

    // ── Async: spin-wait for reply ───────────────────────────────────────

    /// Asynchronous: waits (on a libuv worker thread) for a message whose
    /// correlationId matches `wait_for_id`. Resolves with the message object.
    /// Times out after `timeout_ms` milliseconds.
    #[napi]
    pub fn wait_for_reply(
        &self,
        wait_for_id: BigInt,
        timeout_ms: u32,
    ) -> AsyncTask<WaitTask> {
        let (_, id, _) = wait_for_id.get_u64().unwrap_or((false, 0, false));
        AsyncTask::new(WaitTask {
            inner:      Arc::clone(&self.inner),
            target_id:  id,
            timeout_ms,
        })
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    /// Returns `{ used: bigint, free: bigint }`.
    #[napi]
    pub fn stats(&self, env: Env) -> Result<JsObject> {
        let mut used: u64 = 0;
        let mut free: u64 = 0;
        unsafe { ffi::uipc_stats(self.inner.ptr.as_ptr(), &mut used, &mut free) };

        let mut obj = env.create_object()?;
        obj.set_named_property("used", env.create_bigint_from_u64(used)?.into_unknown())?;
        obj.set_named_property("free", env.create_bigint_from_u64(free)?.into_unknown())?;
        Ok(obj)
    }

    /// Unlink the shm segment (call once, on the owning process).
    #[napi]
    pub fn unlink(&self) {
        unsafe { ffi::uipc_unlink(self.inner.ptr.as_ptr()) };
    }

    /// Maximum payload size in bytes.
    #[napi]
    pub fn max_payload_size() -> u32 {
        unsafe { ffi::uipc_max_payload() }
    }
}

// ── Async task: wait for a correlated reply ────────────────────────────────

pub struct WaitTask {
    inner:      Arc<RingState>,
    target_id:  u64,
    timeout_ms: u32,
}

#[napi]
impl Task for WaitTask {
    type Output  = Option<(ffi::UIPCHeader, Vec<u8>)>;
    type JsValue = JsUnknown;

    fn compute(&mut self) -> Result<Self::Output> {
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_millis(self.timeout_ms as u64);

        let max_payload = unsafe { ffi::uipc_max_payload() } as usize;
        let mut header  = ffi::UIPCHeader::default();
        let mut buf     = vec![0u8; max_payload];
        let mut len: u32 = 0;

        loop {
            let rc = unsafe {
                ffi::uipc_poll(self.inner.ptr.as_ptr(), &mut header, buf.as_mut_ptr(), &mut len)
            };

            if rc == 1 && header.correlation_id == self.target_id {
                buf.truncate(len as usize);
                return Ok(Some((header, buf)));
            }

            if std::time::Instant::now() >= deadline {
                return Ok(None);
            }

            // Back-off: yield to the OS for a microsecond.
            std::hint::spin_loop();
        }
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        match output {
            None => env.get_null().map(|v| v.into_unknown()),
            Some((header, payload)) => {
                let mut obj = env.create_object()?;
                obj.set_named_property("msgType",       env.create_uint32(header.msg_type as u32)?)?;
                obj.set_named_property("msgId",         env.create_bigint_from_u64(header.msg_id)?.into_unknown())?;
                obj.set_named_property("correlationId", env.create_bigint_from_u64(header.correlation_id)?.into_unknown())?;
                obj.set_named_property("senderPid",     env.create_uint32(header.sender_pid as u32)?)?;
                let jsbuf = env.create_buffer_with_data(payload)?;
                obj.set_named_property("payload", jsbuf.into_raw())?;
                Ok(obj.into_unknown())
            }
        }
    }

    fn reject(&mut self, _env: Env, err: Error) -> Result<Self::JsValue> {
        Err(err)
    }
}

// ── Module constants ───────────────────────────────────────────────────────

#[napi]
pub const MSG_CALL:  u8 = msg_type::CALL;
#[napi]
pub const MSG_REPLY: u8 = msg_type::REPLY;
#[napi]
pub const MSG_EVENT: u8 = msg_type::EVENT;
#[napi]
pub const MSG_PING:  u8 = msg_type::PING;
#[napi]
pub const MSG_PONG:  u8 = msg_type::PONG;
#[napi]
pub const MSG_ERROR: u8 = msg_type::ERROR;

// ── Shared Buffer ─────────────────────────────────────────────────────────

struct ShmState {
    ptr: NonNull<ffi::UIPCShm>,
    raw: *mut u8,
    size: usize,
}

unsafe impl Send for ShmState {}
unsafe impl Sync for ShmState {}

impl Drop for ShmState {
    fn drop(&mut self) {
        unsafe { ffi::uipc_shm_close(self.ptr.as_ptr()) };
    }
}

#[napi]
pub struct SharedBufferHandle {
    inner: Arc<ShmState>,
}

#[napi]
impl SharedBufferHandle {
    /// Create a new shared memory region.
    #[napi(factory)]
    pub fn create(env: Env, name: String, size: f64) -> Result<Self> {
        let sz = size as u64;
        let c_name = CString::new(name.clone())
            .map_err(|_| Error::from_reason("Invalid shm name"))?;

        let ptr = unsafe { ffi::uipc_shm_create(c_name.as_ptr(), sz) };
        let nn = NonNull::new(ptr)
            .ok_or_else(|| Error::from_reason(format!("Failed to create shared buffer '{name}'")))?;

        let raw = unsafe { ffi::uipc_shm_ptr(nn.as_ptr()) };
        if raw.is_null() {
            return Err(Error::from_reason("Failed to get shared memory pointer"));
        }

        Ok(Self {
            inner: Arc::new(ShmState { ptr: nn, raw, size: sz as usize }),
        })
    }

    /// Open an existing shared memory region.
    #[napi(factory)]
    pub fn open(env: Env, name: String, size: f64) -> Result<Self> {
        let sz = size as u64;
        let c_name = CString::new(name.clone())
            .map_err(|_| Error::from_reason("Invalid shm name"))?;

        let ptr = unsafe { ffi::uipc_shm_open(c_name.as_ptr(), sz) };
        let nn = NonNull::new(ptr)
            .ok_or_else(|| Error::from_reason(format!("Failed to open shared buffer '{name}'")))?;

        let raw = unsafe { ffi::uipc_shm_ptr(nn.as_ptr()) };
        if raw.is_null() {
            return Err(Error::from_reason("Failed to get shared memory pointer"));
        }

        Ok(Self {
            inner: Arc::new(ShmState { ptr: nn, raw, size: sz as usize }),
        })
    }

    /// Returns an ArrayBuffer backed by the shared memory region.
    /// This is zero-copy — JS reads/writes hit the mmap'd pages directly.
    #[napi]
    pub fn buffer(&self, env: Env) -> Result<JsUnknown> {
        let raw = self.inner.raw;
        let size = self.inner.size;

        // SAFETY: raw points to mmap'd memory that lives as long as ShmState.
        // We use create_external_arraybuffer so the JS ArrayBuffer is backed
        // directly by the shared memory — no copies.
        let buf = unsafe {
            env.create_arraybuffer_with_borrowed_data(
                raw,
                size,
                std::ptr::null_mut::<std::ffi::c_void>(),
                |_, _| {},
            )?
        };
        Ok(buf.into_raw().into_unknown())
    }

    #[napi(getter)]
    pub fn byte_length(&self) -> f64 {
        self.inner.size as f64
    }

    #[napi]
    pub fn unlink(&self) {
        unsafe { ffi::uipc_shm_unlink(self.inner.ptr.as_ptr()) };
    }

    #[napi]
    pub fn close(&self) {
        unsafe { ffi::uipc_shm_close(self.inner.ptr.as_ptr()) };
    }
}
