#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef enum {
    WS_MESSAGE_DROP,
    WS_MESSAGE_MORE,
    WS_MESSAGE_COMPLETE,
} ws_message_result_t;

typedef struct {
    size_t length;
    size_t frame_offset;
    bool active;
    bool dropping;
} ws_message_state_t;

static inline void ws_message_reset(ws_message_state_t *state)
{
    *state = (ws_message_state_t){0};
}

// Append one esp_websocket_client data event. capacity excludes the byte
// reserved by the caller for a trailing NUL.
static inline ws_message_result_t ws_message_append(
    ws_message_state_t *state, uint8_t *buffer, size_t capacity,
    const char *data, int data_len, uint8_t opcode, bool fin,
    int payload_len, int payload_offset)
{
    if (payload_offset == 0) {
        state->frame_offset = 0;
        if (opcode == 0x01) {
            state->length = 0;
            state->active = true;
            state->dropping = false;
        } else if (opcode != 0x00 || !state->active) {
            state->dropping = true;
            return WS_MESSAGE_DROP;
        }
    } else if (!state->active) {
        state->dropping = true;
        return WS_MESSAGE_DROP;
    }

    if (state->dropping) {
        return WS_MESSAGE_DROP;
    }
    if (payload_len < 0 || payload_offset < 0 || data_len < 0 ||
        (data_len > 0 && data == NULL) ||
        (size_t)payload_offset != state->frame_offset ||
        (size_t)payload_offset > (size_t)payload_len ||
        (size_t)data_len > (size_t)payload_len - (size_t)payload_offset ||
        state->length > capacity ||
        (size_t)data_len > capacity - state->length ||
        (payload_offset == 0 &&
         (size_t)payload_len > capacity - state->length)) {
        state->dropping = true;
        return WS_MESSAGE_DROP;
    }

    if (data_len > 0) {
        memcpy(buffer + state->length, data, (size_t)data_len);
        state->length += (size_t)data_len;
        state->frame_offset += (size_t)data_len;
    }
    if (state->frame_offset == (size_t)payload_len && fin) {
        state->active = false;
        return WS_MESSAGE_COMPLETE;
    }
    return WS_MESSAGE_MORE;
}
