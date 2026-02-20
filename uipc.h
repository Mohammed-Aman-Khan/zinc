/**
 * uipc.h — Universal IPC Bridge: C API
 *
 * This header is the FFI contract consumed by:
 *   - Bun (via bun:ffi)
 *   - Node.js (via the Rust N-API addon that links libuipc_core_static)
 *   - Deno (via Deno.dlopen)
 *   - Any other runtime with C FFI support
 */

#pragma once

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── Opaque handle ──────────────────────────────────────────────────────── */

typedef struct UIPCRing UIPCRing;

/* ── Message header (32 bytes, matches Zig extern struct) ───────────────── */

#pragma pack(push, 1)
typedef struct {
    uint8_t  magic;           /* 0x1B */
    uint8_t  version;         /* 0x01 */
    uint16_t flags;
    uint32_t payload_len;
    uint64_t msg_id;
    uint64_t correlation_id;
    uint8_t  msg_type;
    uint16_t sender_pid;
    uint8_t  _pad[5];
} UIPCHeader;
#pragma pack(pop)

static_assert(sizeof(UIPCHeader) == 32, "UIPCHeader must be 32 bytes");

/* ── Message types ──────────────────────────────────────────────────────── */

#define UIPC_MSG_CALL    0x01
#define UIPC_MSG_REPLY   0x02
#define UIPC_MSG_EVENT   0x03
#define UIPC_MSG_PING    0x04
#define UIPC_MSG_PONG    0x05
#define UIPC_MSG_ERROR   0xFF

/* ── Lifecycle ──────────────────────────────────────────────────────────── */

/**
 * Open (or create) a shared memory ring buffer.
 *
 * @param name    POSIX shm name, e.g. "/uipc_bridge_v1"
 * @param create  Non-zero to create+initialize, zero to attach to existing.
 * @return        Opaque ring handle, or NULL on failure.
 */
UIPCRing* uipc_open(const char* name, uint8_t create);

/**
 * Detach from the ring and free the handle.
 * Does NOT unlink the shm segment — call uipc_unlink first if desired.
 */
void uipc_close(UIPCRing* ring);

/**
 * Unlink (destroy) the underlying shm segment.
 */
void uipc_unlink(UIPCRing* ring);

/* ── Producer ───────────────────────────────────────────────────────────── */

/**
 * Send a message into the ring.
 *
 * @param ring           Ring handle.
 * @param msg_type       One of UIPC_MSG_*.
 * @param msg_id         Monotonically increasing message ID (caller manages).
 * @param correlation_id For REPLY messages: the msg_id of the matching CALL.
 * @param payload_ptr    Raw payload bytes.
 * @param payload_len    Number of payload bytes (max uipc_max_payload()).
 * @return 0 on success, -1 on failure.
 */
int uipc_send(
    UIPCRing*    ring,
    uint8_t      msg_type,
    uint64_t     msg_id,
    uint64_t     correlation_id,
    const uint8_t* payload_ptr,
    uint32_t     payload_len
);

/* ── Consumer ───────────────────────────────────────────────────────────── */

/**
 * Poll for one message. Non-blocking.
 *
 * @param ring            Ring handle.
 * @param out_header      Caller-owned 32-byte buffer; filled on success.
 * @param out_payload     Caller-owned buffer of at least uipc_max_payload() bytes.
 * @param out_payload_len Filled with actual payload length on success.
 * @return 1 if a message was consumed, 0 if the ring was empty, -1 on error.
 */
int uipc_poll(
    UIPCRing* ring,
    UIPCHeader* out_header,
    uint8_t*  out_payload,
    uint32_t* out_payload_len
);

/* ── Diagnostics ────────────────────────────────────────────────────────── */

void     uipc_stats(UIPCRing* ring, uint64_t* out_used, uint64_t* out_free);
uint32_t uipc_max_payload(void);

#ifdef __cplusplus
}
#endif
