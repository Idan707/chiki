idf_component_register(
    SRCS "main.c" "audio.c" "face.c" "net.c" "pipeline.c" "progress.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES esp_http_client esp_wifi nvs_flash mbedtls esp_driver_i2s json espressif__esp_websocket_client
)
