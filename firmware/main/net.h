#pragma once
#include <stddef.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

#define BIT_WIFI_UP BIT0
#define NET_SIGNED_URL_CAP 1024
#define NET_DYNAMIC_VARIABLES_CAP 2048
#define NET_SESSION_BODY_CAP 4096

void net_wifi_start(EventGroupHandle_t eg);

// GET WORKER_URL/session -> signed wss URL for one agent conversation.
// Require a complete response and an object of dynamic variables that fits.
// Never start a conversation with silently dropped adventure/privacy settings.
esp_err_t net_get_signed_url(char *out, size_t cap, char *dyn, size_t dyn_cap);

// GET WORKER_URL/progress into a caller-owned JSON buffer.
esp_err_t net_get_progress(char *out, size_t cap);
