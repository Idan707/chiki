#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

#define PROGRESS_DAY_COUNT 84

typedef struct {
    uint32_t cache_version;
    uint32_t revision;
    uint32_t lifetime_explorations;
    uint8_t today_index;
    uint8_t lifetime_topics;
    uint8_t days[PROGRESS_DAY_COUNT];
    char latest_topic[20];
} progress_snapshot_t;

void progress_start(EventGroupHandle_t wifi_events);
void progress_request_refresh(void);
