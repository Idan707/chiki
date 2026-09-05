#include "net.h"
#include "wifi_creds.h"
#include <string.h>
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"

static const char *TAG = "net";
static EventGroupHandle_t s_eg;

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && (id == WIFI_EVENT_STA_START || id == WIFI_EVENT_STA_DISCONNECTED)) {
        if (id == WIFI_EVENT_STA_DISCONNECTED) {
            xEventGroupClearBits(s_eg, BIT_WIFI_UP);
        }
        esp_wifi_connect();  // home toy: retry forever
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ESP_LOGI(TAG, "got ip");
        xEventGroupSetBits(s_eg, BIT_WIFI_UP);
    }
}

void net_wifi_start(EventGroupHandle_t eg)
{
    s_eg = eg;
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));

    wifi_config_t wc = { 0 };
    strlcpy((char *)wc.sta.ssid, WIFI_SSID, sizeof(wc.sta.ssid));
    strlcpy((char *)wc.sta.password, WIFI_PASS, sizeof(wc.sta.password));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());
    // modem power save adds 100-300ms latency spikes - poison for audio
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
}

static esp_err_t get_json(const char *url, char *out, size_t cap)
{
    if (!out || cap < 2) return ESP_ERR_INVALID_ARG;
    out[0] = 0;
    esp_http_client_config_t cfg = {
        .url = url,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .timeout_ms = 10000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) {
        return ESP_FAIL;
    }
    esp_http_client_set_header(client, "Authorization", "Bearer " DEVICE_TOKEN);

    esp_err_t err = ESP_FAIL;
    if (esp_http_client_open(client, 0) != ESP_OK) {
        goto out;
    }
    if (esp_http_client_fetch_headers(client) < 0 ||
        esp_http_client_get_status_code(client) != 200) {
        ESP_LOGE(TAG, "request http %d", esp_http_client_get_status_code(client));
        goto out;
    }
    size_t used = 0;
    for (;;) {
        if (used == cap - 1) {
            ESP_LOGE(TAG, "response too large");
            goto out;
        }
        int n = esp_http_client_read(client, out + used, cap - 1 - used);
        if (n <= 0) {
            if (n == 0 && esp_http_client_is_complete_data_received(client)) break;
            goto out;
        }
        used += n;
    }
    out[used] = 0;
    err = ESP_OK;
out:
    if (err != ESP_OK) out[0] = 0;
    esp_http_client_cleanup(client);
    return err;
}

esp_err_t net_get_signed_url(char *out, size_t cap, char *dyn, size_t dyn_cap)
{
    if (!out || !dyn || cap < 2 || dyn_cap < 2) return ESP_ERR_INVALID_ARG;
    out[0] = dyn[0] = 0;
    char body[NET_SESSION_BODY_CAP];
    if (get_json(WORKER_URL "/session", body, sizeof(body)) != ESP_OK) return ESP_FAIL;
    cJSON *root = cJSON_ParseWithOpts(body, NULL, true);
    const cJSON *su = cJSON_GetObjectItemCaseSensitive(root, "signed_url");
    const cJSON *variables = cJSON_GetObjectItemCaseSensitive(root, "dynamic_variables");
    char *dv = cJSON_IsObject(variables) ? cJSON_PrintUnformatted(variables) : NULL;
    esp_err_t err = ESP_FAIL;
    if (cJSON_IsString(su) && !strncmp(su->valuestring, "wss://", 6) &&
        strlen(su->valuestring) < cap && dv && strlen(dv) < dyn_cap) {
        strcpy(out, su->valuestring);
        strcpy(dyn, dv);
        err = ESP_OK;
    }
    cJSON_free(dv);
    cJSON_Delete(root);
    return err;
}

esp_err_t net_get_progress(char *out, size_t cap)
{
    return get_json(WORKER_URL "/progress", out, cap);
}
