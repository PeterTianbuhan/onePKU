#!/usr/bin/env python3
"""Personal playback-progress sidecar.

Listens on 127.0.0.1 only. Caddy on the same machine exposes it under a path.
The bearer token comes from ONEPKU_PROGRESS_TOKEN and is never written here.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
import sys
import threading
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

TOKEN_KEYS = {"token", "access_token", "authorization", "bearer"}
MAX_BODY = 256 * 1024
MAX_RECORDS = 500
ID_LIMIT = 128


def parse_time(value: str) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError("naive timestamp")
    return parsed.astimezone(timezone.utc)


def token_matches(given: str, expected: str) -> bool:
    # Hash both sides so compare_digest stays constant-time when lengths differ.
    return hmac.compare_digest(
        hashlib.sha256(given.encode()).digest(),
        hashlib.sha256(expected.encode()).digest(),
    )


def query_has_token(query: str) -> bool:
    if not query:
        return False
    for key, _value in urllib.parse.parse_qsl(query, keep_blank_values=True):
        if key.lower() in TOKEN_KEYS:
            return True
    return False


def merge(current: dict[str, Any] | None, incoming: dict[str, Any]) -> dict[str, Any]:
    """Last write wins on updated_at for position. completed stays true."""
    if current is None:
        return dict(incoming)
    current_at = parse_time(current["updated_at"])
    incoming_at = parse_time(incoming["updated_at"])
    winner = incoming if incoming_at >= current_at else current
    merged = dict(winner)
    merged["completed"] = bool(current["completed"]) or bool(incoming["completed"])
    return merged


def check_record(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("record")
    course_id = raw.get("course_id")
    episode_id = raw.get("episode_id")
    device_id = raw.get("device_id")
    position = raw.get("position_seconds")
    completed = raw.get("completed")
    updated_at = raw.get("updated_at")
    for text, limit in (
        (course_id, ID_LIMIT),
        (episode_id, ID_LIMIT),
        (device_id, 64),
    ):
        if not isinstance(text, str) or not text.strip() or len(text) > limit:
            raise ValueError("id")
        if any(ord(ch) < 32 for ch in text):
            raise ValueError("id")
    if isinstance(position, bool) or not isinstance(position, (int, float)):
        raise ValueError("position")
    if position < 0 or position > 14 * 24 * 3600 or position != position:
        raise ValueError("position")
    if not isinstance(completed, bool):
        raise ValueError("completed")
    if not isinstance(updated_at, str):
        raise ValueError("updated_at")
    parse_time(updated_at)
    return {
        "course_id": course_id,
        "episode_id": episode_id,
        "position_seconds": float(position),
        "completed": completed,
        "updated_at": updated_at,
        "device_id": device_id,
    }


class Store:
    def __init__(self, path: str) -> None:
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS progress (
                course_id TEXT NOT NULL,
                episode_id TEXT NOT NULL,
                position_seconds REAL NOT NULL,
                completed INTEGER NOT NULL,
                updated_at TEXT NOT NULL,
                device_id TEXT NOT NULL,
                PRIMARY KEY (course_id, episode_id)
            )
            """
        )
        self._db.commit()
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def _row(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "course_id": row["course_id"],
            "episode_id": row["episode_id"],
            "position_seconds": row["position_seconds"],
            "completed": bool(row["completed"]),
            "updated_at": row["updated_at"],
            "device_id": row["device_id"],
        }

    def all(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                """
                SELECT course_id, episode_id, position_seconds, completed, updated_at, device_id
                FROM progress
                ORDER BY course_id, episode_id
                """
            ).fetchall()
        return [self._row(row) for row in rows]

    def upsert(self, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        merged: list[dict[str, Any]] = []
        with self._lock:
            for record in records:
                row = self._db.execute(
                    """
                    SELECT course_id, episode_id, position_seconds, completed, updated_at, device_id
                    FROM progress WHERE course_id = ? AND episode_id = ?
                    """,
                    (record["course_id"], record["episode_id"]),
                ).fetchone()
                current = self._row(row) if row is not None else None
                nxt = merge(current, record)
                self._db.execute(
                    """
                    INSERT INTO progress (
                        course_id, episode_id, position_seconds, completed, updated_at, device_id
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(course_id, episode_id) DO UPDATE SET
                        position_seconds = excluded.position_seconds,
                        completed = excluded.completed,
                        updated_at = excluded.updated_at,
                        device_id = excluded.device_id
                    """,
                    (
                        nxt["course_id"],
                        nxt["episode_id"],
                        nxt["position_seconds"],
                        1 if nxt["completed"] else 0,
                        nxt["updated_at"],
                        nxt["device_id"],
                    ),
                )
                merged.append(nxt)
            self._db.commit()
        return merged


class Handler(BaseHTTPRequestHandler):
    server: ProgressServer

    def log_message(self, fmt: str, *args: Any) -> None:
        # The request target may contain a rejected query token. Log the path only.
        path = urllib.parse.urlsplit(self.path).path
        code = args[1] if len(args) > 1 else ""
        sys.stderr.write(f"{self.command} {path} {code}\n")

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        if query_has_token(parsed.query):
            self._json(400, {"error": "query_token_rejected"})
            return
        if parsed.path == "/healthz":
            self._json(200, {"ok": True})
            return
        if parsed.path == "/v1/progress":
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            self._json(200, {"records": self.server.store.all()})
            return
        self._json(404, {"error": "not_found"})

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        if query_has_token(parsed.query):
            self._json(400, {"error": "query_token_rejected"})
            return
        if parsed.path != "/v1/progress":
            self._json(404, {"error": "not_found"})
            return
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json(400, {"error": "bad_request"})
            return
        if length < 0 or length > MAX_BODY:
            self._json(413, {"error": "body_too_large"})
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode())
            records = payload["records"]
            if not isinstance(records, list) or len(records) > MAX_RECORDS:
                raise ValueError("records")
            checked = [check_record(item) for item in records]
        except (ValueError, KeyError, json.JSONDecodeError, UnicodeError):
            self._json(400, {"error": "bad_request"})
            return
        self._json(200, {"records": self.server.store.upsert(checked)})

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        scheme, _, given = header.partition(" ")
        if scheme != "Bearer":
            return False
        given = given.strip()
        if not given or " " in given:
            return False
        return token_matches(given, self.server.token)

    def _json(self, code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


class ProgressServer(ThreadingHTTPServer):
    def __init__(self, token: str, store: Store, port: int) -> None:
        super().__init__(("127.0.0.1", port), Handler)
        self.token = token
        self.store = store


def main() -> int:
    token = os.environ.get("ONEPKU_PROGRESS_TOKEN", "")
    if len(token) < 24 or any(ch.isspace() for ch in token):
        print("ONEPKU_PROGRESS_TOKEN must be at least 24 non-space characters", file=sys.stderr)
        return 2
    directory = os.environ.get("ONEPKU_PROGRESS_DIR", "/var/lib/onepku-progress")
    try:
        port = int(os.environ.get("ONEPKU_PROGRESS_PORT", "8787"))
    except ValueError:
        print("ONEPKU_PROGRESS_PORT is not a port", file=sys.stderr)
        return 2
    if not 1 <= port <= 65535:
        print("ONEPKU_PROGRESS_PORT is not a port", file=sys.stderr)
        return 2
    os.makedirs(directory, mode=0o700, exist_ok=True)
    try:
        os.chmod(directory, 0o700)
    except OSError:
        pass
    store = Store(os.path.join(directory, "progress.sqlite"))
    server = ProgressServer(token, store, port)
    # Ignore any requested public bind. This process is localhost only.
    print(f"listening on 127.0.0.1:{server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
