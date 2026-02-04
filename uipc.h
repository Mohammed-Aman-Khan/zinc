#pragma once

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C"
{
#endif

    typedef struct UIPCRing UIPCRing;

#pragma pack(push, 1)
    typedef struct
    {
        uint8_t magic;
        uint8_t version;
        uint16_t flags;
        uint32_t payload_len;
        uint64_t msg_id;
        uint64_t correlation_id;
        uint8_t msg_type;
        uint16_t sender_pid;
        uint8_t _pad[5];
    } UIPCHeader;
#pragma pack(pop)

    static_assert(sizeof(UIPCHeader) == 32, "UIPCHeader must be 32 bytes");

#define UIPC_MSG_CALL 0x01
#define UIPC_MSG_REPLY 0x02
#define UIPC_MSG_EVENT 0x03
#define UIPC_MSG_PING 0x04
#define UIPC_MSG_PONG 0x05
#define UIPC_MSG_ERROR 0xFF

    UIPCRing *uipc_open(const char *name, uint8_t create);

    void uipc_close(UIPCRing *ring);

    void uipc_unlink(UIPCRing *ring);

    int uipc_send(
        UIPCRing *ring,
        uint8_t msg_type,
        uint64_t msg_id,
        uint64_t correlation_id,
        const uint8_t *payload_ptr,
        uint32_t payload_len);

    int uipc_poll(
        UIPCRing *ring,
        UIPCHeader *out_header,
        uint8_t *out_payload,
        uint32_t *out_payload_len);

    void uipc_stats(UIPCRing *ring, uint64_t *out_used, uint64_t *out_free);
    uint32_t uipc_max_payload(void);

#ifdef __cplusplus
}
#endif
