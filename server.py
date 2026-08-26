#!/usr/bin/env python3
"""Local dev server for the family tree app.

Serves the static frontend (index.html, js/*) and a small JSON API backed
directly by data.sqlite, so edits made in the UI are written straight to
the database file on disk -- no browser file-write APIs, no downloads.

Run with:
    python3 server.py [port]
"""
import json
import re
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data.sqlite"

EDITABLE_FIELDS = {"name", "surname", "gender", "birthdate", "birthplace", "note"}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".sqlite": "application/x-sqlite3",
}


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def fetch_tree():
    conn = get_connection()
    try:
        people = [dict(row) for row in conn.execute("SELECT * FROM People")]
        spouses = list(conn.execute("SELECT * FROM Spouses"))
        parents = list(conn.execute("SELECT * FROM Parents"))
    finally:
        conn.close()

    for person in people:
        pid = person["id"]
        person["spouseIds"] = [
            (row["spouse2Id"] if row["spouse1Id"] == pid else row["spouse1Id"])
            for row in spouses
            if row["spouse1Id"] == pid or row["spouse2Id"] == pid
        ]
        person["parentIds"] = [
            parent_id
            for row in parents if row["childId"] == pid
            for parent_id in (row["parent1Id"], row["parent2Id"])
            if parent_id is not None
        ]
    return people


def update_person(person_id, fields):
    updates = {k: v for k, v in fields.items() if k in EDITABLE_FIELDS}
    if not updates:
        raise ValueError("Düzenlenecek geçerli bir alan gönderilmedi.")
    if "name" in updates and not str(updates["name"] or "").strip():
        raise ValueError("Ad boş olamaz.")
    if "gender" in updates and updates["gender"] not in (0, 1, 2):
        raise ValueError("Geçersiz cinsiyet değeri.")

    conn = get_connection()
    try:
        row = conn.execute("SELECT id FROM People WHERE id = ?", (person_id,)).fetchone()
        if row is None:
            raise LookupError("Kişi bulunamadı.")

        set_clause = ", ".join(f"{key} = ?" for key in updates)
        conn.execute(
            f"UPDATE People SET {set_clause} WHERE id = ?",
            (*updates.values(), person_id),
        )
        conn.commit()

        updated = conn.execute("SELECT * FROM People WHERE id = ?", (person_id,)).fetchone()
        return dict(updated)
    finally:
        conn.close()


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, url_path):
        if url_path == "/":
            url_path = "/index.html"
        candidate = (ROOT / url_path.lstrip("/")).resolve()
        if candidate != ROOT and ROOT not in candidate.parents:
            self._send_json(403, {"error": "Forbidden"})
            return
        if not candidate.is_file():
            self._send_json(404, {"error": "Not found"})
            return

        data = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(candidate.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/tree":
            try:
                self._send_json(200, {"people": fetch_tree()})
            except Exception as exc:
                self._send_json(500, {"error": str(exc)})
            return
        self._serve_static(path)

    def do_PATCH(self):
        match = re.fullmatch(r"/api/people/(\d+)", urlparse(self.path).path)
        if not match:
            self._send_json(404, {"error": "Not found"})
            return

        person_id = int(match.group(1))
        length = int(self.headers.get("Content-Length", 0) or 0)
        try:
            fields = json.loads(self.rfile.read(length) or b"{}")
            updated = update_person(person_id, fields)
            self._send_json(200, updated)
        except LookupError as exc:
            self._send_json(404, {"error": str(exc)})
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def log_message(self, format_str, *args):
        sys.stderr.write(f"{self.address_string()} - {format_str % args}\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    if not DB_PATH.is_file():
        print(f"data.sqlite not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    server = ThreadingHTTPServer(("localhost", port), Handler)
    print(f"Family tree server running at http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
