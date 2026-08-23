#include "audio.h"
#include "face.h"
#include "net.h"
#include "pipeline.h"
#include "progress.h"
#include "bsp/esp32_s3_touch_amoled_1_8.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "nvs_flash.h"

void app_main(void)
{
    // PA enable is a strapping pin - force amp off until the codec owns it
    gpio_reset_pin(BSP_POWER_AMP_IO);
    gpio_set_direction(BSP_POWER_AMP_IO, GPIO_MODE_OUTPUT);
    gpio_set_level(BSP_POWER_AMP_IO, 0);

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    bsp_display_start();
    bsp_display_backlight_on();
    face_init();

    ESP_ERROR_CHECK(audio_init());
    pipeline_start();
    net_wifi_start(pipeline_event_group());
    progress_start(pipeline_event_group());
}
