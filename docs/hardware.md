# Hardware guide

## Supported board

Kidbot v0.1.0 is verified on the **Waveshare ESP32-S3-Touch-AMOLED-1.8 V2**. It uses the board's AMOLED display and touch controller plus its onboard microphone, speaker, and ES8311 audio codec.

Waveshare documents different display and touch controllers for V1 and V2. V1 is therefore **unverified**, not assumed compatible. Check the revision printed on the board and compare it with the [official Waveshare documentation](https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-1.8).

## What you need

- Waveshare ESP32-S3-Touch-AMOLED-1.8 V2
- Data-capable USB-C cable
- Computer with a USB serial device visible
- [ESP-IDF 5.5.4](https://docs.espressif.com/projects/esp-idf/en/v5.5.4/esp32s3/get-started/)
- A deployed Kidbot Worker and matching device token

## Credentials

```sh
cp firmware/main/wifi_creds.h.example firmware/main/wifi_creds.h
```

Edit the ignored copy with your Wi-Fi name/password, the HTTPS Worker origin without a trailing slash, and the same strong token stored in the Worker's `DEVICE_TOKEN` secret. Never commit `wifi_creds.h`.

## Build, flash, and monitor

Use a pinned ESP-IDF installation rather than whichever version happens to be on your path:

```sh
. /path/to/esp-idf-v5.5.4/export.sh
idf.py -C firmware build
idf.py -C firmware -p /dev/your-serial-port app-flash
idf.py -C firmware -p /dev/your-serial-port monitor
```

On macOS the port commonly resembles `/dev/cu.usbmodem*`; on Linux it commonly resembles `/dev/ttyACM*`. Find the actual device on your machine instead of copying an example path blindly.

`firmware/dependencies.lock` is committed so the managed component graph stays reproducible for this fixed board. Do not edit it by hand. `firmware/managed_components/`, `firmware/build/`, and generated `sdkconfig` files stay ignored.

## Physical interaction

- Short tap while idle: start a conversation.
- Short tap during a conversation: close cleanly with code `1000`.
- Swipe left: show the cached curiosity map.

The face indicates listening, buffering, and playback. Treat those visible states as a privacy feature: do not redesign them into an ambiguous background-listening mode.

## Audio calibration

Both directions use 16 kHz signed 16-bit mono PCM. The `PREBUFFER` value in `firmware/main/pipeline.c` is a hardware calibration knob; `48,000` bytes is the measured 1.5-second setting for the verified board. Change it only after testing the real codec and speaker path.

During buffering and playback, firmware sends zero PCM for the same elapsed duration and flushes microphone input before listening resumes. Keep that half-duplex behavior to avoid echo and broken stream timing.

## Troubleshooting

| Symptom | Check |
|---|---|
| No serial port | Try a data-capable cable, another USB port, and boot/download mode. |
| Build uses the wrong tools | Re-run the 5.5.4 `export.sh`, then confirm `idf.py --version`. |
| Wi-Fi connects but sessions fail | Verify the Worker URL, matching device token, and `GET /` health response. |
| HTTP 401 | The compiled token and Worker `DEVICE_TOKEN` differ, or the Worker secret is absent. |
| HTTP 429 | The validated daily session cap is exhausted. Wait for the UTC counter day or adjust the positive cap deliberately. |
| Choppy first words | Re-test the physical speaker path before changing `PREBUFFER`. |
| Conversation never returns idle | Confirm `agent_response_complete` is enabled and that the playback queue drains. |
| Wrong display/touch behavior | Confirm the board is V2; V1 is not supported yet. |
