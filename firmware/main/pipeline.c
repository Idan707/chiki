// Conversation session: tap -> ticketed wss URL from our Worker -> Worker
// WebSocket. The Worker runs the whole loop (transcribe, answer, screen the
// reply, synthesise) and streams 16 kHz PCM back, so the device stays a thin
// audio endpoint and no API key ever reaches it. Half-duplex by construction:
// the one task below either pumps mic chunks up or drains agent audio to the
// speaker, never both, so the agent can't hear itself (no AEC, no barge-in).
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
#include "freertos/semphr.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"

static const char *TAG = "pipeline";

#define BIT_PRESS       BIT1
#define BIT_AGENT_AUDIO BIT2
#define BIT_AGENT_DONE  BIT3

#define MIC_CHUNK   8192                      // 256ms @ 16k/16/mono
// Audio is raw PCM in binary frames both ways now, not base64 inside JSON. That
// removes the encode/decode step and the two multi-megabyte scratch buffers the
// ElevenLabs protocol needed; control messages are small text frames.
#define ACC_CAP     (256 * 1024)              // one ws message, reassembled
#define PLAY_BUF    (2 * 1024 * 1024)         // ~65s of agent audio
#define TX_BUF      (256 * 1024)               // 8s upload cushion; network must never stall speaker
#define PREBUFFER   48000                     // 1.5s: TTS arrives in bursts; less = mid-sentence stutter
#define CTRL_MAX    4096                      // control frames are tiny; ignore anything bigger
// PSRAM, not .bss: the LCD needs a large contiguous internal DMA block per
// redraw and TLS handshakes already crowd internal RAM.
#define DYN_SZ      1024                      // widest weekly adventure is ~585 bytes

static EventGroupHandle_t s_eg;
static esp_websocket_client_handle_t s_ws;
// tx_task can still be blocked inside a 2s send when session() gives up waiting
// for it, and destroying the client under it panics with LoadProhibited. Every
// use of s_ws goes through this lock, and teardown nulls it while holding it.
static SemaphoreHandle_t s_ws_lock;
static StreamBufferHandle_t s_play, s_tx;
static uint8_t *s_acc, *s_tx_pcm;
static char *s_dyn;
static size_t s_acc_len;
static bool s_acc_drop, s_acc_bin;
static volatile bool s_ws_up;
static volatile bool s_end_req;
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

// Agent audio: a complete binary frame of raw PCM, straight to the speaker
// queue. No parsing, no decode, no copy beyond the queue itself.
static void on_audio(const uint8_t *pcm, size_t len)
{
    size_t sent = xStreamBufferSend(s_play, pcm, len, 0);
    if (sent < len) {
        s_play_dropped += len - sent;
        ESP_LOGW(TAG, "play buffer full, dropped=%u total=%u",
                 (unsigned)(len - sent), (unsigned)s_play_dropped);
    }
    s_last_audio = xTaskGetTickCount();
    xEventGroupSetBits(s_eg, BIT_AGENT_AUDIO);
}

// An absent field yields NULL, and NULL through a %s panics with
// LoadProhibited inside vfprintf. The Worker legitimately omits `text` on a
// thinking frame, which crashed the board on the first real conversation.
static const char *field(const cJSON *root, const char *key, const char *fallback)
{
    const char *value = cJSON_GetStringValue(cJSON_GetObjectItem(root, key));
    return value ? value : fallback;
}

// Control: small text frames from our own Worker. The Worker owns turn
// detection, the safety screen and synthesis, so the device only reacts.
static void on_control(char *msg, size_t len)
{
    if (len > CTRL_MAX) {
        ESP_LOGW(TAG, "oversized control frame (%u bytes)", (unsigned)len);
        return;
    }
    cJSON *root = cJSON_Parse(msg);
    if (!root) {
        return;
    }
    const char *type = cJSON_GetStringValue(cJSON_GetObjectItem(root, "t"));
    if (!type) {
        cJSON_Delete(root);
        return;
    }
    if (!strcmp(type, "ready")) {
        ESP_LOGI(TAG, "session up id=%s", field(root, "id", "?"));
    } else if (!strcmp(type, "thinking")) {
        face_set_state(FACE_THINKING);      // kid's turn ended, worker working
        ESP_LOGI(TAG, "heard: %s", field(root, "text", "(audio)"));
    } else if (!strcmp(type, "speaking")) {
        ESP_LOGI(TAG, "agent: %s", field(root, "text", ""));
    } else if (!strcmp(type, "done")) {
        xEventGroupSetBits(s_eg, BIT_AGENT_DONE);
    } else if (!strcmp(type, "bye")) {
        ESP_LOGI(TAG, "worker ended the session: %s", field(root, "why", "?"));
        s_end_req = true;
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
        if (e->op_code != 0x01 && e->op_code != 0x02 && e->op_code != 0x00) {
            break;                          // text, binary and continuation only
        }
        if (e->payload_offset == 0) {
            s_acc_len = 0;
            s_acc_bin = e->op_code == 0x02;  // continuations carry op_code 0
            s_acc_drop = e->payload_len > ACC_CAP - 1;
            if (s_acc_drop) {
                ESP_LOGW(TAG, "dropping %d byte message", e->payload_len);
            }
        }
        if (!s_acc_drop && e->data_len > 0) {
            memcpy(s_acc + s_acc_len, e->data_ptr, e->data_len);
            s_acc_len += e->data_len;
            if ((int)s_acc_len == e->payload_len) {
                if (s_acc_bin) {
                    on_audio(s_acc, s_acc_len);
                } else {
                    s_acc[s_acc_len] = 0;
                    on_control((char *)s_acc, s_acc_len);
                }
            }
        }
        break;
    }
}

static bool ws_send(const char *data, int len, bool binary, const char *what)
{
    for (int attempt = 0; attempt < 2; attempt++) {
        xSemaphoreTake(s_ws_lock, portMAX_DELAY);
        int sent = s_ws
            ? (binary
               ? esp_websocket_client_send_bin(s_ws, data, len, pdMS_TO_TICKS(2000))
               : esp_websocket_client_send_text(s_ws, data, len, pdMS_TO_TICKS(2000)))
            : -1;                           // torn down under us; fail, don't crash
        xSemaphoreGive(s_ws_lock);
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

// Raw PCM in a binary frame: no base64, so no 33% inflation and no scratch
// buffer. The Worker owns turn detection, so the device just keeps streaming
// while it is listening.
static bool send_audio_chunk(const uint8_t *pcm, size_t len)
{
    if (len == 0 || len > MIC_CHUNK) {
        ESP_LOGE(TAG, "invalid mic chunk length=%u", (unsigned)len);
        return false;
    }
    return ws_send((const char *)pcm, len, true, "audio");
}

static void tx_task(void *arg)
{
    while (!s_tx_stop && s_ws_up) {
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
    char *dyn = s_dyn;
    if (net_get_signed_url(url, sizeof(url), dyn, DYN_SZ) != ESP_OK) {
        goto fail;
    }

    s_acc_len = 0;
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
        .disable_auto_reconnect = true,     // the session ticket is single-use
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
    // No client hello: the Worker picked this session's adventure and holds it
    // against the ticket, so it opens the conversation on its own. dyn is kept
    // only as a diagnostic that the pairing is intact.
    ESP_LOGI(TAG, "adventure: %s", dyn[0] ? dyn : "(worker-side)");
    // The LCD competes for this: if the largest block drops below the draw
    // buffer the screen stops updating and never recovers.
    ESP_LOGI(TAG, "internal dma at session: free=%u largest=%u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA));
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
            ESP_LOGW(TAG, "turn-done frame missing; using 10s failsafe");
            xEventGroupSetBits(s_eg, BIT_AGENT_DONE);
            bits |= BIT_AGENT_DONE;
        }

        // Nothing is uploaded once the agent has the floor. The old protocol
        // needed equal-duration zero PCM to keep the remote timeline aligned;
        // our Worker owns turn detection, so silence on the wire is silence.
        if (phase == BUFFERING || queued == 0) {
            if (phase == PLAYING && (bits & BIT_AGENT_DONE)) {
                for (int i = 0; i < 2; i++) {
                    int n = audio_read(pcm, sizeof(pcm));  // flush speaker bleed
                    if (n <= 0 || audio_write((void *)silence, n) < 0) {
                        ESP_LOGE(TAG, "microphone flush failed: %d", n);
                        goto close_audio;
                    }
                }
                xEventGroupClearBits(s_eg, BIT_AGENT_AUDIO | BIT_AGENT_DONE);
                phase = LISTENING;
                face_set_state(FACE_LISTENING);
                continue;
            }
            if (audio_write((void *)silence, sizeof(silence)) < 0) {
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
    }

close_audio:
    if (tx_started) {
        s_tx_stop = true;
        // one ws_send is up to 2s x 2 attempts, so 5s was a coin flip; 15s is
        // clear of it. Overrunning is no longer fatal - the lock below makes
        // teardown safe either way - but a second tx_task would share s_tx.
        for (int i = 0; i < 150 && !s_tx_done; i++) {
            vTaskDelay(pdMS_TO_TICKS(100));
        }
        if (!s_tx_done) {
            ESP_LOGW(TAG, "audio sender task still running; teardown is locked");
        }
    }
    audio_close();
fail_ws:
    xSemaphoreTake(s_ws_lock, portMAX_DELAY);
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
        s_ws = NULL;                        // ws_send now fails instead of faulting
    }
    xSemaphoreGive(s_ws_lock);
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
    // These six buffers are ~4.9 MB of PSRAM and run after the display is
    // already up, so a failure here aborts into a reboot loop that looks like a
    // dead screen. Log the budget either way: a blank display is a panic until
    // the monitor says otherwise.
    ESP_LOGI(TAG, "psram before: free=%u largest=%u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));

    s_eg = xEventGroupCreate();
    s_ws_lock = xSemaphoreCreateMutex();
    s_acc = heap_caps_malloc(ACC_CAP, MALLOC_CAP_SPIRAM);
    s_tx_pcm = heap_caps_malloc(MIC_CHUNK, MALLOC_CAP_SPIRAM);
    s_dyn = heap_caps_malloc(DYN_SZ, MALLOC_CAP_SPIRAM);
    s_play = xStreamBufferCreateWithCaps(PLAY_BUF, 4096, MALLOC_CAP_SPIRAM);  // chunky reads, no dribble
    s_tx = xStreamBufferCreateWithCaps(TX_BUF, 1, MALLOC_CAP_SPIRAM);

    if (!s_acc || !s_tx_pcm || !s_play || !s_tx ||
        !s_ws_lock || !s_dyn) {
        ESP_LOGE(TAG, "psram exhausted: wanted %u bytes, free=%u largest=%u "
                 "(acc=%d tx_pcm=%d play=%d tx=%d dyn=%d)",
                 (unsigned)(ACC_CAP + MIC_CHUNK + PLAY_BUF + TX_BUF + DYN_SZ),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM),
                 !!s_acc, !!s_tx_pcm, !!s_play, !!s_tx, !!s_dyn);
    }
    assert(s_acc && s_tx_pcm && s_play && s_tx &&
           s_ws_lock && s_dyn);

    ESP_LOGI(TAG, "psram after: free=%u largest=%u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
    // the LCD needs one big contiguous block of this per redraw; TLS eats it
    ESP_LOGI(TAG, "internal dma: free=%u largest=%u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA));
    xTaskCreate(task, "pipeline", 12288, NULL, 5, NULL);
}
