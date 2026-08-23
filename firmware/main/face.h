#pragma once
#include "progress.h"

typedef enum {
    FACE_BOOTING,
    FACE_IDLE,
    FACE_LISTENING,
    FACE_THINKING,
    FACE_SPEAKING,
    FACE_SAD,
} face_state_t;

void face_init(void);                 // call with LVGL running; takes bsp_display_lock itself
void face_set_state(face_state_t s);  // thread-safe (atomic write, timer picks it up)
void face_set_progress(const progress_snapshot_t *snapshot); // thread-safe queued snapshot
