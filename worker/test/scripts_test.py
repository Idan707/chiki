#!/usr/bin/env python3
"""Offline regression checks; fake curl/Wrangler never contact cloud services."""
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory(prefix="chiki-script-test-") as directory:
    root = Path(directory)
    (root / "scripts").mkdir()
    (root / "bin").mkdir()
    for name in ("configure_progress_webhook.sh", "safety_tests.py"):
        shutil.copyfile(ROOT / "scripts" / name, root / "scripts" / name)
    config = root / ".dev.vars"
    config.write_text("ELEVENLABS_API_KEY=test-only-key\nWORKER_URL=https://example.invalid\nELEVEN_WEBHOOK_SECRET=\n")
    fake = '''import json, pathlib, sys
args = sys.argv[1:]
if pathlib.Path(sys.argv[0]).name == 'curl':
    if 'POST' in args:
        pathlib.Path('.created').touch()
        print(json.dumps({'webhook_id': 'test-webhook', 'webhook_secret': 'test-only-secret'}))
        print(200)
    elif 'PATCH' in args:
        print('{}')
    else:
        print(json.dumps({'webhooks': ([{'webhook_id': 'test-webhook',
            'webhook_url': 'https://example.invalid/webhooks/elevenlabs',
            'is_disabled': False, 'is_auto_disabled': False}]
            if pathlib.Path('.created').exists() else [])}))
else:
    assert args == ['--no-install', 'wrangler', 'secret', 'put', 'ELEVEN_WEBHOOK_SECRET']
    assert sys.stdin.read() == 'test-only-secret'
    attempts = pathlib.Path('.push-attempts')
    count = int(attempts.read_text()) + 1 if attempts.exists() else 1
    attempts.write_text(str(count))
    sys.exit(1 if count == 1 else 0)
'''
    for name in ("curl", "npx"):
        script = root / "bin" / name
        script.write_text(f"#!{sys.executable}\n" + fake)
        script.chmod(0o700)
    env = {**os.environ, "PATH": str(root / "bin") + os.pathsep + os.environ["PATH"]}

    def provision():
        return subprocess.run(["bash", str(root / "scripts/configure_progress_webhook.sh")],
                              env=env, capture_output=True, text=True)

    assert provision().returncode != 0  # Creation succeeds; first secret upload fails.
    assert "ELEVEN_WEBHOOK_SECRET=test-only-secret" in config.read_text()
    result = provision()
    assert result.returncode == 0, result.stderr
    assert (root / ".push-attempts").read_text() == "2"
    config.write_text(config.read_text().replace("ELEVEN_WEBHOOK_SECRET=test-only-secret", "ELEVEN_WEBHOOK_SECRET="))
    assert provision().returncode != 0  # Existing webhook with a lost secret must fail closed.
    assert (root / ".push-attempts").read_text() == "2"

    safety = runpy.run_path(str(root / "scripts/safety_tests.py"))
    for case in safety["CASES"]:
        variables = safety["payload"](*case)["dynamic_variables"]
        assert variables["progress_enabled"] is False
        assert variables["last_topic"] == ""
        assert variables["opening_line"]
        assert "return_line" not in variables

print("scripts: interrupted provisioning retry, missing-secret failure and safety variables passed")
