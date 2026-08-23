#pragma once
#include <stdbool.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

void pipeline_start(void);            // alloc buffer, create task
void pipeline_touch(bool pressed);    // called from LVGL touch callback
bool pipeline_session_active(void);   // thread-safe touch/gesture gate
EventGroupHandle_t pipeline_event_group(void);  // shared with net (BIT_WIFI_UP)
