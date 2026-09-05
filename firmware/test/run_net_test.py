#!/usr/bin/env python3
"""Compile and run net.c on the host with ESP transport stubs and IDF's real cJSON."""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CJSON = Path(os.environ["IDF_PATH"]) / "components/json/cJSON"

with tempfile.TemporaryDirectory(prefix="chiki-net-test-") as directory:
    temp = Path(directory)
    for name in ("net.c", "net.h"):
        shutil.copyfile(ROOT / "main" / name, temp / name)
    shutil.copyfile(ROOT / "main/wifi_creds.h.example", temp / "wifi_creds.h")
    for name in ("esp_err.h", "esp_crt_bundle.h", "esp_event.h", "esp_http_client.h",
                 "esp_log.h", "esp_netif.h", "esp_wifi.h", "freertos/FreeRTOS.h",
                 "freertos/event_groups.h"):
        stub = temp / name
        stub.parent.mkdir(parents=True, exist_ok=True)
        stub.touch()
    binary = temp / "net-test"
    subprocess.run([
        os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra",
        "-Wno-unused-parameter", "-I", str(temp), "-I", str(CJSON),
        str(ROOT / "test/net_test.c"), str(CJSON / "cJSON.c"), "-lm", "-o", str(binary),
    ], check=True)
    subprocess.run([str(binary)], check=True)
