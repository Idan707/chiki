#pragma once
#include "esp_err.h"

#define AUDIO_SAMPLE_RATE 16000   // must match agent pcm_16000 both directions

esp_err_t audio_init(void);              // once at boot; PA stays off
esp_err_t audio_open(void);              // 16000/16/mono, gain+volume set
void audio_close(void);                  // PA off
int audio_read(void *buf, int len);      // blocking, full chunk; <0 on error
int audio_write(void *buf, int len);
