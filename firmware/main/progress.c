#include "progress.h"
#include "face.h"
#include "net.h"
#include <string.h>
#include "cJSON.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"

static const char *TAG = "progress";
static const uint32_t CACHE_VERSION = 1;
static EventGroupHandle_t s_wifi_events;
static TaskHandle_t s_task;

static bool topic_ok(const char *topic)
{
    static const char *const topics[] = {
        "space", "jungle", "detectives", "oceans", "dinosaurs", "inventors",
        "human_body", "ancient_egypt", "insects", "weather", "other", "",
    };
    if (!topic) return false;
    for (size_t i = 0; i < sizeof(topics) / sizeof(topics[0]); i++) {
        if (!strcmp(topic, topics[i])) return true;
    }
    return false;
}

static bool parse_snapshot(const char *json, progress_snapshot_t *out)
{
    cJSON *root = cJSON_Parse(json);
    if (!root) return false;
    const cJSON *version = cJSON_GetObjectItem(root, "version");
    const cJSON *revision = cJSON_GetObjectItem(root, "revision");
    const cJSON *today = cJSON_GetObjectItem(root, "today_index");
    const cJSON *days = cJSON_GetObjectItem(root, "days");
    const cJSON *topics = cJSON_GetObjectItem(root, "lifetime_topics");
    const cJSON *explorations = cJSON_GetObjectItem(root, "lifetime_explorations");
    const char *latest = cJSON_GetStringValue(cJSON_GetObjectItem(root, "latest_topic"));
    bool ok = cJSON_IsNumber(version) && version->valueint == 1 &&
              cJSON_IsNumber(revision) && revision->valuedouble >= 0 &&
              cJSON_IsNumber(today) && today->valueint >= 0 && today->valueint < PROGRESS_DAY_COUNT &&
              cJSON_IsArray(days) && cJSON_GetArraySize(days) == PROGRESS_DAY_COUNT &&
              cJSON_IsNumber(topics) && topics->valueint >= 0 && topics->valueint <= 11 &&
              cJSON_IsNumber(explorations) && explorations->valuedouble >= 0 && topic_ok(latest);
    progress_snapshot_t parsed = { .cache_version = CACHE_VERSION };
    if (ok) {
        parsed.revision = (uint32_t)revision->valuedouble;
        parsed.today_index = today->valueint;
        parsed.lifetime_topics = topics->valueint;
        parsed.lifetime_explorations = (uint32_t)explorations->valuedouble;
        strlcpy(parsed.latest_topic, latest, sizeof(parsed.latest_topic));
        for (int i = 0; i < PROGRESS_DAY_COUNT; i++) {
            const cJSON *day = cJSON_GetArrayItem(days, i);
            if (!cJSON_IsNumber(day) || day->valueint < 0 || day->valueint > 4 ||
                day->valuedouble != day->valueint) {
                ok = false;
                break;
            }
            parsed.days[i] = day->valueint;
        }
    }
    cJSON_Delete(root);
    if (ok) *out = parsed;
    return ok;
}

static void load_cache(void)
{
    nvs_handle_t nvs;
    progress_snapshot_t snapshot;
    size_t len = sizeof(snapshot);
    if (nvs_open("curiosity", NVS_READONLY, &nvs) != ESP_OK) return;
    esp_err_t err = nvs_get_blob(nvs, "snapshot", &snapshot, &len);
    nvs_close(nvs);
    if (err == ESP_OK && len == sizeof(snapshot) && snapshot.cache_version == CACHE_VERSION &&
        snapshot.today_index < PROGRESS_DAY_COUNT && topic_ok(snapshot.latest_topic)) {
        face_set_progress(&snapshot);
        ESP_LOGI(TAG, "loaded cached revision=%lu", (unsigned long)snapshot.revision);
    }
}

static void save_cache(const progress_snapshot_t *snapshot)
{
    nvs_handle_t nvs;
    if (nvs_open("curiosity", NVS_READWRITE, &nvs) != ESP_OK) return;
    esp_err_t err = nvs_set_blob(nvs, "snapshot", snapshot, sizeof(*snapshot));
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    if (err != ESP_OK) ESP_LOGW(TAG, "cache save failed: %s", esp_err_to_name(err));
}

static void progress_task(void *arg)
{
    static char body[1024];
    for (;;) {
        xEventGroupWaitBits(s_wifi_events, BIT_WIFI_UP, pdFALSE, pdFALSE, portMAX_DELAY);
        progress_snapshot_t snapshot;
        if (net_get_progress(body, sizeof(body)) == ESP_OK && parse_snapshot(body, &snapshot)) {
            face_set_progress(&snapshot);
            save_cache(&snapshot);
            ESP_LOGI(TAG, "synced revision=%lu", (unsigned long)snapshot.revision);
        } else {
            ESP_LOGW(TAG, "progress refresh failed; keeping cached map");
        }
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    }
}

void progress_start(EventGroupHandle_t wifi_events)
{
    s_wifi_events = wifi_events;
    load_cache();
    if (xTaskCreate(progress_task, "progress", 6144, NULL, 2, &s_task) != pdPASS) {
        s_task = NULL;
        ESP_LOGE(TAG, "task creation failed");
    }
}

void progress_request_refresh(void)
{
    if (s_task) xTaskNotifyGive(s_task);
}
