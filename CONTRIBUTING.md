# Contributing to Chiki

Thanks for helping make Chiki safer, simpler, and easier to build.

## Before you start

- Search existing issues before opening a new one.
- Use an issue for a large design change before writing substantial code.
- Never include secrets, child data, transcripts, recordings, live service IDs, or local credential files.
- Security and privacy problems belong in a [private security advisory](https://github.com/Idan707/chiki/security/advisories/new), not a public issue.

## Development setup

Worker checks require Node.js 24. Python tools require Python 3.11+ and the packages in `worker/requirements-dev.txt`.

```sh
cd worker
npm ci
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.txt
npm test
npm run check
python -m py_compile scripts/*.py
for script in scripts/*.sh; do bash -n "$script"; done
shellcheck scripts/*.sh
python test/scripts_test.py
cd ..
```

Firmware requires ESP-IDF 5.5.4:

```sh
. /path/to/esp-idf-v5.5.4/export.sh
cp firmware/main/wifi_creds.h.example firmware/main/wifi_creds.h
python3 firmware/test/run_net_test.py
idf.py -C firmware build
git diff --exit-code -- firmware/dependencies.lock
```

Use placeholders in the local credentials file for a compile-only check. Do not overwrite an existing private credentials file. The host network test uses IDF's cJSON and stubbed ESP transport, with no real credentials or network access.

## Pull requests

Keep changes focused, explain observable behavior, and include the smallest test that would catch a regression. Update public docs when setup, safety, data flow, or hardware behavior changes. CI must pass; deployment is always manual.

For firmware behavior, test the real V2 board and report:

- short tap starts and ends a session;
- listening, buffering, and playback states are visible;
- authenticated `/session` succeeds;
- input and output are 16 kHz PCM;
- playback drains after `agent_response_complete`;
- the WebSocket closes with code `1000`;
- failed progress refresh preserves the last valid map.

Agent changes also require a maintainer-supplied WAV run with `progress=0` and all four `private blocking` safety cases. Do not commit the WAV or test output.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
