// Conversation session: tap -> signed URL from worker -> ElevenLabs agent
// WebSocket. Half-duplex by construction: the one task below either pumps mic
// chunks up or drains agent audio to the speaker, never both, so the agent
// can't hear itself (no AEC needed, no barge-in).
#include "pipeline.h"
#include "audio.h"
#include "face.h"
#include "net.h"
#include <stdatomic.h>
#include <string.h>
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/idf_additions.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"

static const char *TAG = "pipeline";

#define BIT_PRESS       BIT1
#define BIT_AGENT_AUDIO BIT2
#define BIT_AGENT_DONE  BIT3

#define MIC_CHUNK   8192                      // 256ms @ 16k/16/mono
#define MIC_JSON_SZ (MIC_CHUNK / 3 * 4 + 64)  // {"user_audio_chunk":"<b64>"}
#define ACC_CAP     (1536 * 1024)             // one ws message, reassembled
#define DEC_CAP     (1152 * 1024)             // base64-decoded audio scratch
#define PLAY_BUF    (2 * 1024 * 1024)         // ~65s of agent audio
#define TX_BUF      (256 * 1024)               // 8s upload cushion; network must never stall speaker
#define PREBUFFER   48000                     // 1.5s: TTS arrives in bursts; less = mid-sentence stutter

static EventGroupHandle_t s_eg;
static esp_websocket_client_handle_t s_ws;
static StreamBufferHandle_t s_play, s_tx;
static uint8_t *s_acc, *s_dec, *s_tx_pcm;
static char *s_mic_json;
static size_t s_acc_len;
static bool s_acc_drop;
static volatile bool s_ws_up;
static volatile bool s_end_req;
static volatile int s_pong_id = -1;
static volatile TickType_t s_last_audio;
static volatile size_t s_play_dropped;
static volatile bool s_tx_stop, s_tx_done;
static atomic_bool s_session_active;

EventGroupHandle_t pipeline_event_group(void) { return s_eg; }
bool pipeline_session_active(void) { return atomic_load(&s_session_active); }

void pipeline_touch(bool pressed)
{
    if (!s_eg || !pressed) {
        return;
    }
    s_end_req = true;                       // no-op unless a session is live
    xEventGroupSetBits(s_eg, BIT_PRESS);
}

// Complete ws text message. Audio events can be huge - grab the base64 span
// by hand instead of letting cJSON duplicate the payload; everything else is
// small and goes through cJSON.
static void on_message(char *msg, size_t len)
{
    char *b64 = strstr(msg, "\"audio_base_64\":\"");
    if (b64) {
        b64 += 17;
        char *end = strchr(b64, '"');
        if (!end) {
            return;
        }
        size_t out_len = 0;
        if (mbedtls_base64_decode(s_dec, DEC_CAP, &out_len,
                                  (uint8_t *)b64, end - b64) != 0) {
            ESP_LOGE(TAG, "b64 decode failed (%u chars)", (unsigned)(end - b64));
            return;
        }
        size_t sent = xStreamBufferSend(s_play, s_dec, out_len, 0);
        if (sent < out_len) {
            s_play_dropped += out_len - sent;
            ESP_LOGW(TAG, "play buffer full, dropped=%u total=%u",
                     (unsigned)(out_len - sent), (unsigned)s_play_dropped);
        }
        s_last_audio = xTaskGetTickCount();
        xEventGroupSetBits(s_eg, BIT_AGENT_AUDIO);
        return;
    }
    if (len > 8192) {
        return;  // unknown jumbo message
    }
    cJSON *root = cJSON_Parse(msg);
    if (!root) {
        return;
    }
    const char *type = cJSON_GetStringValue(cJSON_GetObjectItem(root, "type"));
    if (!type) {
        cJSON_Delete(root);
        return;
    }
    if (!strcmp(type, "ping")) {
        const cJSON *ev = cJSON_GetObjectItem(root, "ping_event");
        s_pong_id = (int)cJSON_GetNumberValue(cJSON_GetObjectItem(ev, "event_id"));
    } else if (!strcmp(type, "user_transcript")) {
        face_set_state(FACE_THINKING);      // kid's turn ended, agent working
        ESP_LOGI(TAG, "heard: %s", cJSON_GetStringValue(cJSON_GetObjectItem(
            cJSON_GetObjectItem(root, "user_transcription_event"), "user_transcript")));
    } else if (!strcmp(type, "agent_response")) {
        ESP_LOGI(TAG, "agent: %s", cJSON_GetStringValue(cJSON_GetObjectItem(
            cJSON_GetObjectItem(root, "agent_response_event"), "agent_response")));
    } else if (!strcmp(type, "agent_response_complete")) {
        xEventGroupSetBits(s_eg, BIT_AGENT_DONE);
    } else if (!strcmp(type, "conversation_initiation_metadata")) {
        const cJSON *ev = cJSON_GetObjectItem(root, "conversation_initiation_metadata_event");
        ESP_LOGI(TAG, "session up id=%s audio out=%s in=%s",
                 cJSON_GetStringValue(cJSON_GetObjectItem(ev, "conversation_id")),
                 cJSON_GetStringValue(cJSON_GetObjectItem(ev, "agent_output_audio_format")),
                 cJSON_GetStringValue(cJSON_GetObjectItem(ev, "user_input_audio_format")));
    }
    cJSON_Delete(root);
}

static void ws_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    esp_websocket_event_data_t *e = data;
    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
        s_ws_up = true;
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
        ESP_LOGW(TAG, "ws disconnected close=%d", e->close_status_code);
        s_ws_up = false;
        break;
    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGE(TAG, "ws error type=%d close=%d http=%d tls=0x%x stack=0x%x cert=0x%x errno=%d",
                 e->error_handle.error_type, e->close_status_code,
                 e->error_handle.esp_ws_handshake_status_code,
                 e->error_handle.esp_tls_last_esp_err,
                 e->error_handle.esp_tls_stack_err,
                 e->error_handle.esp_tls_cert_verify_flags,
                 e->error_handle.esp_transport_sock_errno);
        s_ws_up = false;
        break;
    case WEBSOCKET_EVENT_CLOSED:
        ESP_LOGI(TAG, "ws closed code=%d", e->close_status_code);
        s_ws_up = false;
        break;
    case WEBSOCKET_EVENT_DATA:
        if (e->op_code == 0x08) {           // server close frame
            ESP_LOGI(TAG, "server close frame code=%d", e->close_status_code);
            s_ws_up = false;
            break;
        }
        if (e->op_code != 0x01 && e->op_code != 0x00) {
            break;                          // text + continuation only
        }
        if (e->payload_offset == 0) {
            s_acc_len = 0;
            s_acc_drop = e->payload_len > ACC_CAP - 1;
            if (s_acc_drop) {
                ESP_LOGW(TAG, "dropping %d byte message", e->payload_len);
            }
        }
        if (!s_acc_drop && e->data_len > 0) {
            memcpy(s_acc + s_acc_len, e->data_ptr, e->data_len);
            s_acc_len += e->data_len;
            if ((int)s_acc_len == e->payload_len) {
                s_acc[s_acc_len] = 0;
                on_message((char *)s_acc, s_acc_len);
            }
        }
        break;
    }
}

static bool ws_send(const char *data, int len, const char *what)
{
    for (int attempt = 0; attempt < 2; attempt++) {
        int sent = esp_websocket_client_send_text(s_ws, data, len, pdMS_TO_TICKS(2000));
        if (sent == len) {
            return true;
        }
        if (sent < 0 && attempt == 0 && s_ws_up && !s_tx_stop) {
            ESP_LOGW(TAG, "%s send blocked; retrying", what);
            continue;
        }
        ESP_LOGE(TAG, "%s send failed sent=%d expected=%d", what, sent, len);
        return false;
    }
    return false;
}

static bool send_pong(void)
{
    int id = s_pong_id;
    if (id < 0) {
        return true;
    }
    s_pong_id = -1;
    char pong[48];
    int n = snprintf(pong, sizeof(pong), "{\"type\":\"pong\",\"event_id\":%d}", id);
    return ws_send(pong, n, "pong");
}

static bool send_audio_chunk(const uint8_t *pcm, size_t len)
{
    if (len == 0 || len > MIC_CHUNK) {
        ESP_LOGE(TAG, "invalid mic chunk length=%u", (unsigned)len);
        return false;
    }
    size_t b64_len = 0;
    memcpy(s_mic_json, "{\"user_audio_chunk\":\"", 21);
    int rc = mbedtls_base64_encode((uint8_t *)s_mic_json + 21,
                                   MIC_JSON_SZ - 24, &b64_len, pcm, len);
    if (rc != 0) {
        ESP_LOGE(TAG, "mic b64 encode failed rc=%d length=%u", rc, (unsigned)len);
        return false;
    }
    memcpy(s_mic_json + 21 + b64_len, "\"}", 2);
    int expected = 21 + b64_len + 2;
    return ws_send(s_mic_json, expected, "audio");
}

static void tx_task(void *arg)
{
    while (!s_tx_stop && s_ws_up) {
        if (!send_pong()) {
            s_ws_up = false;
            break;
        }
        size_t n = xStreamBufferReceive(s_tx, s_tx_pcm, MIC_CHUNK,
                                        pdMS_TO_TICKS(100));
        if (n > 0 && !send_audio_chunk(s_tx_pcm, n)) {
            s_ws_up = false;
            break;
        }
    }
    s_tx_done = true;
    vTaskDelete(NULL);
}

static bool queue_audio(const uint8_t *pcm, size_t len)
{
    size_t sent = xStreamBufferSend(s_tx, pcm, len, 0);
    if (sent != len) {
        ESP_LOGE(TAG, "upload buffer full, dropped=%u", (unsigned)(len - sent));
        s_ws_up = false;
        return false;
    }
    return true;
}

static void session(void)
{
    atomic_store(&s_session_active, true);
    bool tx_started = false;
    face_set_state(FACE_THINKING);
    static char url[768];
    static char dyn[512];
    if (net_get_signed_url(url, sizeof(url), dyn, sizeof(dyn)) != ESP_OK) {
        goto fail;
    }

    s_acc_len = 0;
    s_pong_id = -1;
    s_play_dropped = 0;
    s_tx_stop = false;
    s_tx_done = false;
    xEventGroupClearBits(s_eg, BIT_AGENT_AUDIO | BIT_AGENT_DONE);
    xStreamBufferReset(s_play);
    xStreamBufferReset(s_tx);

    esp_websocket_client_config_t cfg = {
        .uri = url,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 4096,   // internal RAM; fragments reassemble into s_acc anyway
        .task_stack = 8192,
        .disable_auto_reconnect = true,     // signed URL is single-use
        .network_timeout_ms = 10000,
    };
    s_ws = esp_websocket_client_init(&cfg);
    if (!s_ws) {
        goto fail;
    }
    esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, ws_event, NULL);
    esp_err_t err = esp_websocket_client_start(s_ws);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ws start failed: %s", esp_err_to_name(err));
        goto fail_ws;
    }
    for (int i = 0; i < 100 && !s_ws_up; i++) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (!s_ws_up || audio_open() != ESP_OK) {
        goto fail_ws;
    }
    // server won't speak the greeting until the client announces itself;
    // dynamic_variables = worker-picked weekly adventure for the first message
    static char hello[640];
    int hn = dyn[0]
        ? snprintf(hello, sizeof(hello), "{\"type\":\"conversation_initiation_"
                   "client_data\",\"dynamic_variables\":%s}", dyn)
        : snprintf(hello, sizeof(hello),
                   "{\"type\":\"conversation_initiation_client_data\"}");
    if (!ws_send(hello, hn, "conversation initiation")) {
        goto close_audio;
    }
    tx_started = xTaskCreate(tx_task, "audio_tx", 6144, NULL, 4, NULL) == pdPASS;
    if (!tx_started) {
        ESP_LOGE(TAG, "audio sender task creation failed");
        goto close_audio;
    }

    static uint8_t pcm[MIC_CHUNK];
    static const uint8_t silence[MIC_CHUNK];
    enum { LISTENING, BUFFERING, PLAYING } phase = LISTENING;
    face_set_state(FACE_LISTENING);
    while (s_ws_up && !s_end_req) {
        EventBits_t bits = xEventGroupGetBits(s_eg);
        size_t queued = xStreamBufferBytesAvailable(s_play);
        if (phase == LISTENING && (bits & BIT_AGENT_AUDIO)) {
            phase = BUFFERING;
        }
        if (phase == BUFFERING &&
            (queued >= PREBUFFER || ((bits & BIT_AGENT_DONE) && queued > 0))) {
            phase = PLAYING;
            face_set_state(FACE_SPEAKING);
        }

        if (phase == LISTENING) {
            int n = audio_read(pcm, sizeof(pcm));
            if (n <= 0) {
                ESP_LOGE(TAG, "microphone read failed: %d", n);
                break;
            }
            if (!queue_audio(pcm, n)) {
                break;
            }
            if ((bits & BIT_AGENT_DONE) && !(bits & BIT_AGENT_AUDIO)) {
                ESP_LOGW(TAG, "response completed without audio");
                xEventGroupClearBits(s_eg, BIT_AGENT_DONE);
            }
            continue;
        }

        if (xTaskGetTickCount() - s_last_audio > pdMS_TO_TICKS(10000) &&
            !(bits & BIT_AGENT_DONE)) {
            ESP_LOGW(TAG, "agent_response_complete missing; using 10s failsafe");
            xEventGroupSetBits(s_eg, BIT_AGENT_DONE);
            bits |= BIT_AGENT_DONE;
        }

        if (phase == BUFFERING || queued == 0) {
            if (phase == PLAYING && (bits & BIT_AGENT_DONE)) {
                for (int i = 0; i < 2; i++) {
                    int n = audio_read(pcm, sizeof(pcm));  // flush speaker bleed
                    if (n <= 0 || audio_write((void *)silence, n) < 0 ||
                        !queue_audio(silence, n)) {
                        ESP_LOGE(TAG, "microphone flush failed: %d", n);
                        goto close_audio;
                    }
                }
                xEventGroupClearBits(s_eg, BIT_AGENT_AUDIO | BIT_AGENT_DONE);
                phase = LISTENING;
                face_set_state(FACE_LISTENING);
                continue;
            }
            if (audio_write((void *)silence, sizeof(silence)) < 0 ||
                !queue_audio(silence, sizeof(silence))) {
                ESP_LOGE(TAG, "buffering silence failed");
                break;
            }
            continue;
        }

        size_t n = xStreamBufferReceive(s_play, pcm, sizeof(pcm), 0);
        if (n == 0) {
            ESP_LOGE(TAG, "play stream read failed with %u bytes queued", (unsigned)queued);
            break;
        }
        if (audio_write(pcm, n) < 0) {
            ESP_LOGE(TAG, "speaker write failed length=%u", (unsigned)n);
            break;
        }
        if (!queue_audio(silence, n)) {
            break;
        }
    }

close_audio:
    if (tx_started) {
        s_tx_stop = true;
        for (int i = 0; i < 50 && !s_tx_done; i++) {
            vTaskDelay(pdMS_TO_TICKS(100));
        }
        if (!s_tx_done) {
            ESP_LOGE(TAG, "audio sender task did not stop");
        }
    }
    audio_close();
fail_ws:
    if (s_ws) {
        if (s_end_req && esp_websocket_client_is_connected(s_ws)) {
            err = esp_websocket_client_close_with_code(
                s_ws, 1000, NULL, 0, pdMS_TO_TICKS(1000));
        } else {
            err = esp_websocket_client_close(s_ws, pdMS_TO_TICKS(1000));
        }
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "ws close failed: %s", esp_err_to_name(err));
        }
        esp_websocket_client_destroy(s_ws);
        s_ws = NULL;
    }
    s_ws_up = false;
fail:
    if (!s_end_req) {  // tap-to-end is a clean exit; anything else shows sad
        face_set_state(FACE_SAD);
        vTaskDelay(pdMS_TO_TICKS(1500));
    }
    atomic_store(&s_session_active, false);
}

static void task(void *arg)
{
    for (;;) {
        face_set_state(FACE_IDLE);
        xEventGroupClearBits(s_eg, BIT_PRESS);
        xEventGroupWaitBits(s_eg, BIT_PRESS, pdTRUE, pdFALSE, portMAX_DELAY);
        s_end_req = false;                  // that press starts, not ends

        if (!(xEventGroupGetBits(s_eg) & BIT_WIFI_UP)) {
            face_set_state(FACE_SAD);
            vTaskDelay(pdMS_TO_TICKS(1500));
            continue;
        }
        session();
    }
}

void pipeline_start(void)
{
    s_eg = xEventGroupCreate();
    s_acc = heap_caps_malloc(ACC_CAP, MALLOC_CAP_SPIRAM);
    s_dec = heap_caps_malloc(DEC_CAP, MALLOC_CAP_SPIRAM);
    s_tx_pcm = heap_caps_malloc(MIC_CHUNK, MALLOC_CAP_SPIRAM);
    s_mic_json = heap_caps_malloc(MIC_JSON_SZ, MALLOC_CAP_SPIRAM);
    s_play = xStreamBufferCreateWithCaps(PLAY_BUF, 4096, MALLOC_CAP_SPIRAM);  // chunky reads, no dribble
    s_tx = xStreamBufferCreateWithCaps(TX_BUF, 1, MALLOC_CAP_SPIRAM);
    assert(s_acc && s_dec && s_tx_pcm && s_mic_json && s_play && s_tx);
    xTaskCreate(task, "pipeline", 12288, NULL, 5, NULL);
}
