#pragma once
#include <stddef.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

#define BIT_WIFI_UP BIT0

void net_wifi_start(EventGroupHandle_t eg);

// GET WORKER_URL/session -> signed wss URL for one agent conversation.
// dyn gets the response's dynamic_variables JSON object verbatim (session
// topics for the agent), or "" if absent/oversized - never a hard failure.
esp_err_t net_get_signed_url(char *out, size_t cap, char *dyn, size_t dyn_cap);

// GET WORKER_URL/progress into a caller-owned JSON buffer.
esp_err_t net_get_progress(char *out, size_t cap);
