// Host regression checks for the real net.c; only ESP transport/Wi-Fi are stubbed.
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int esp_err_t;
typedef void *EventGroupHandle_t;
typedef const char *esp_event_base_t;
typedef int wifi_init_config_t;
typedef struct { struct { char ssid[32], password[64]; } sta; } wifi_config_t;
typedef struct { const char *url; void *crt_bundle_attach; int timeout_ms; } esp_http_client_config_t;
typedef void *esp_http_client_handle_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_INVALID_ARG -2
#define BIT0 1
static const char test_wifi_event[] = "wifi", test_ip_event[] = "ip";
#define WIFI_EVENT test_wifi_event
#define IP_EVENT test_ip_event
#define WIFI_EVENT_STA_START 1
#define WIFI_EVENT_STA_DISCONNECTED 2
#define IP_EVENT_STA_GOT_IP 3
#define ESP_EVENT_ANY_ID 0
#define WIFI_MODE_STA 0
#define WIFI_IF_STA 0
#define WIFI_PS_NONE 0
#define WIFI_INIT_CONFIG_DEFAULT() 0
#define ESP_ERROR_CHECK(value) assert((value) == ESP_OK)
#define ESP_LOGI(tag, ...) ((void)(tag))
#define ESP_LOGE(tag, ...) ((void)(tag))
#define xEventGroupClearBits(...) ((void)0)
#define xEventGroupSetBits(...) ((void)0)
#define esp_wifi_connect() ESP_OK
#define esp_netif_init() ESP_OK
#define esp_event_loop_create_default() ESP_OK
#define esp_netif_create_default_wifi_sta() ((void)0)
#define esp_wifi_init(cfg) ((void)(cfg), ESP_OK)
#define esp_event_handler_register(base, id, handler, arg) ((void)(handler), ESP_OK)
#define esp_wifi_set_mode(...) ESP_OK
#define esp_wifi_set_config(...) ESP_OK
#define esp_wifi_start() ESP_OK
#define esp_wifi_set_ps(...) ESP_OK
#define esp_crt_bundle_attach NULL
static size_t copy_string(char *dst, const char *src, size_t cap) {
    snprintf(dst, cap, "%s", src);
    return strlen(src);
}
#undef strlcpy
#define strlcpy copy_string

static const char *response;
static size_t offset, delivered, fragment;
static int status;
static bool complete;
static esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t *cfg) {
    (void)cfg;
    return (void *)1;
}
#define esp_http_client_set_header(...) ((void)0)
#define esp_http_client_open(...) ESP_OK
#define esp_http_client_fetch_headers(...) 0
#define esp_http_client_get_status_code(...) status
#define esp_http_client_is_complete_data_received(...) complete
#define esp_http_client_cleanup(...) ((void)0)
static int esp_http_client_read(esp_http_client_handle_t client, char *out, int capacity) {
    (void)client;
    size_t n = delivered - offset;
    if (n > fragment) n = fragment;
    if (n > (size_t)capacity) n = capacity;
    memcpy(out, response + offset, n);
    offset += n;
    return (int)n;
}

#include "net.c"

static void reply(const char *body, size_t chunk) {
    response = body;
    delivered = strlen(body);
    offset = 0;
    fragment = chunk;
    status = 200;
    // Headers may already have buffered the entire body before the first read.
    complete = true;
}

int main(void) {
    char url[NET_SIGNED_URL_CAP], dyn[NET_DYNAMIC_VARIABLES_CAP];
    const char *valid = "{\"signed_url\":\"wss://example.invalid/session\",\"dynamic_variables\":{\"progress_enabled\":false}}";
    reply(valid, 7);
    assert(net_get_signed_url(url, sizeof(url), dyn, sizeof(dyn)) == ESP_OK);
    assert(!strcmp(url, "wss://example.invalid/session"));
    assert(!strcmp(dyn, "{\"progress_enabled\":false}"));

    char long_response[NET_SESSION_BODY_CAP + 64];
    memset(long_response, ' ', 1200);
    strcpy(long_response + 1200, valid);
    reply(long_response, 137);
    assert(net_get_signed_url(url, sizeof(url), dyn, sizeof(dyn)) == ESP_OK);

    reply(valid, 7);
    delivered -= 4;
    complete = false;
    assert(net_get_signed_url(url, sizeof(url), dyn, sizeof(dyn)) == ESP_FAIL);
    assert(!url[0] && !dyn[0]);
    reply(valid, 7);
    status = 401;
    assert(net_get_signed_url(url, sizeof(url), dyn, sizeof(dyn)) == ESP_FAIL);
    reply("{\"signed_url\":\"wss://example.invalid/session\"}", 256);
    assert(net_get_signed_url(url, sizeof(url), dyn, sizeof(dyn)) == ESP_FAIL);
    reply(valid, 256);
    assert(net_get_signed_url(url, sizeof(url), dyn, 8) == ESP_FAIL);

    memset(long_response, ' ', sizeof(long_response) - 1);
    long_response[sizeof(long_response) - 1] = 0;
    reply(long_response, 137);
    assert(net_get_signed_url(url, sizeof(url), dyn, sizeof(dyn)) == ESP_FAIL);
    reply("{\"version\":1}", 2);
    assert(net_get_progress(dyn, sizeof(dyn)) == ESP_OK);
    assert(!strcmp(dyn, "{\"version\":1}"));
    puts("net.c: fragmented, buffered, oversized, unauthorized and truncated responses passed");
}
