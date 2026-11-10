import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import progress_sync


TOKEN = "a" * 32


def record(**overrides):
    base = {
        "course_id": "course-1",
        "episode_id": "episode-1",
        "position_seconds": 10,
        "completed": False,
        "updated_at": "2026-11-10T00:00:00Z",
        "device_id": "device-a",
    }
    base.update(overrides)
    return base


class MergeTest(unittest.TestCase):
    def test_newer_position_wins(self):
        merged = progress_sync.merge(
            record(position_seconds=10, updated_at="2026-11-10T00:00:00Z", device_id="phone"),
            record(position_seconds=40, updated_at="2026-11-10T00:01:00Z", device_id="desktop"),
        )
        self.assertEqual(40, merged["position_seconds"])
        self.assertEqual("desktop", merged["device_id"])
        self.assertEqual("2026-11-10T00:01:00Z", merged["updated_at"])
        self.assertFalse(merged["completed"])

    def test_older_position_does_not_win(self):
        merged = progress_sync.merge(
            record(position_seconds=40, updated_at="2026-11-10T00:02:00Z"),
            record(position_seconds=5, updated_at="2026-11-10T00:01:00Z", device_id="stale"),
        )
        self.assertEqual(40, merged["position_seconds"])
        self.assertEqual("device-a", merged["device_id"])

    def test_completed_sticks_when_the_older_write_finished(self):
        merged = progress_sync.merge(
            record(position_seconds=90, completed=True, updated_at="2026-11-10T00:00:00Z"),
            record(position_seconds=15, completed=False, updated_at="2026-11-10T00:05:00Z"),
        )
        self.assertEqual(15, merged["position_seconds"])
        self.assertTrue(merged["completed"])

    def test_completed_sticks_when_the_newer_write_finished(self):
        merged = progress_sync.merge(
            record(completed=False, updated_at="2026-11-10T00:00:00Z"),
            record(position_seconds=80, completed=True, updated_at="2026-11-10T00:05:00Z"),
        )
        self.assertTrue(merged["completed"])
        self.assertEqual(80, merged["position_seconds"])

    def test_equal_timestamp_lets_the_incoming_position_win(self):
        merged = progress_sync.merge(
            record(position_seconds=10, device_id="old"),
            record(position_seconds=12, device_id="new"),
        )
        self.assertEqual(12, merged["position_seconds"])
        self.assertEqual("new", merged["device_id"])


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = progress_sync.Store(os.path.join(self.tmp.name, "progress.sqlite"))
        self.server = progress_sync.ProgressServer(TOKEN, self.store, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.store.close()
        self.thread.join(timeout=2)
        self.tmp.cleanup()

    def request(self, path, method="GET", body=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=3) as resp:
                return resp.status, json.loads(resp.read().decode())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read().decode())

    def authed(self, path, method="GET", body=None):
        return self.request(path, method, body, {"Authorization": f"Bearer {TOKEN}"})

    def test_healthz_needs_no_auth(self):
        status, payload = self.request("/healthz")
        self.assertEqual(200, status)
        self.assertEqual({"ok": True}, payload)

    def test_progress_rejects_missing_and_wrong_bearer(self):
        status, payload = self.request("/v1/progress")
        self.assertEqual(401, status)
        self.assertEqual("unauthorized", payload["error"])
        status, payload = self.request("/v1/progress", headers={"Authorization": "Bearer nope"})
        self.assertEqual(401, status)
        status, _payload = self.request("/v1/progress", headers={"Authorization": f"Basic {TOKEN}"})
        self.assertEqual(401, status)

    def test_query_string_token_is_rejected_even_with_a_valid_bearer(self):
        status, payload = self.authed(f"/v1/progress?token={TOKEN}")
        self.assertEqual(400, status)
        self.assertEqual("query_token_rejected", payload["error"])
        status, payload = self.authed("/healthz?access_token=abc")
        self.assertEqual(400, status)
        self.assertNotIn(TOKEN, json.dumps(payload))

    def test_put_merges_last_write_wins_and_sticky_completed(self):
        status, payload = self.authed(
            "/v1/progress",
            "PUT",
            {"records": [record(position_seconds=90, completed=True, updated_at="2026-11-10T00:00:00Z")]},
        )
        self.assertEqual(200, status)
        self.assertTrue(payload["records"][0]["completed"])
        status, payload = self.authed(
            "/v1/progress",
            "PUT",
            {
                "records": [
                    record(
                        position_seconds=15,
                        completed=False,
                        updated_at="2026-11-10T00:05:00Z",
                        device_id="desktop",
                    )
                ]
            },
        )
        self.assertEqual(200, status)
        saved = payload["records"][0]
        self.assertEqual(15, saved["position_seconds"])
        self.assertTrue(saved["completed"])
        self.assertEqual("desktop", saved["device_id"])
        status, listed = self.authed("/v1/progress")
        self.assertEqual(200, status)
        self.assertEqual(saved, listed["records"][0])

    def test_older_put_does_not_move_position(self):
        self.authed(
            "/v1/progress",
            "PUT",
            {"records": [record(position_seconds=40, updated_at="2026-11-10T00:02:00Z")]},
        )
        status, payload = self.authed(
            "/v1/progress",
            "PUT",
            {"records": [record(position_seconds=5, updated_at="2026-11-10T00:01:00Z", device_id="stale")]},
        )
        self.assertEqual(200, status)
        self.assertEqual(40, payload["records"][0]["position_seconds"])
        self.assertEqual("device-a", payload["records"][0]["device_id"])


if __name__ == "__main__":
    unittest.main()
