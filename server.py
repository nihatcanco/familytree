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

EDITABLE_FIELDS = {"name", "surname", "gender", "birthdate", "birthplace", "note", "dateofdeath"}

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


def _ancestor_ids(conn, person_id, seen=None):
    """All ids reachable by walking up the Parents chain from person_id."""
    if seen is None:
        seen = set()
    row = conn.execute("SELECT parent1Id, parent2Id FROM Parents WHERE childId = ?", (person_id,)).fetchone()
    if not row:
        return seen
    for pid in (row["parent1Id"], row["parent2Id"]):
        if pid is not None and pid not in seen:
            seen.add(pid)
            _ancestor_ids(conn, pid, seen)
    return seen


def _next_id(conn, table):
    # These tables declare "id INT AUTO_INCREMENT" (MySQL-style DDL), which
    # SQLite does NOT treat as a rowid-alias (only the exact type "INTEGER"
    # gets that treatment) -- so ids are never assigned automatically and
    # must be computed explicitly on every insert.
    row = conn.execute(f"SELECT MAX(id) AS max_id FROM {table}").fetchone()
    return (row["max_id"] or 0) + 1


def _update_parents(conn, person_id, parent_ids):
    if not isinstance(parent_ids, list) or len(parent_ids) > 2:
        raise ValueError("Geçersiz ebeveyn listesi.")

    ids = []
    for pid in parent_ids:
        if pid is None:
            continue
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            raise ValueError("Geçersiz ebeveyn kimliği.")
        if pid == person_id:
            raise ValueError("Bir kişi kendi ebeveyni olamaz.")
        if pid not in ids:
            ids.append(pid)
    if len(ids) > 2:
        raise ValueError("En fazla 2 ebeveyn seçilebilir.")

    for pid in ids:
        exists = conn.execute("SELECT id FROM People WHERE id = ?", (pid,)).fetchone()
        if exists is None:
            raise ValueError(f"Ebeveyn olarak seçilen kişi ({pid}) bulunamadı.")
        if person_id in _ancestor_ids(conn, pid):
            raise ValueError("Bu seçim döngüsel bir soy ilişkisi oluşturur.")

    existing = conn.execute("SELECT id FROM Parents WHERE childId = ?", (person_id,)).fetchone()
    if not ids:
        if existing:
            conn.execute("DELETE FROM Parents WHERE childId = ?", (person_id,))
        return

    parent1Id, parent2Id = ids[0], (ids[1] if len(ids) > 1 else None)
    if existing:
        conn.execute(
            "UPDATE Parents SET parent1Id = ?, parent2Id = ? WHERE childId = ?",
            (parent1Id, parent2Id, person_id),
        )
    else:
        conn.execute(
            "INSERT INTO Parents (id, childId, parent1Id, parent2Id) VALUES (?, ?, ?, ?)",
            (_next_id(conn, "Parents"), person_id, parent1Id, parent2Id),
        )


def _insert_spouses(conn, person_id, spouse_ids):
    if spouse_ids is None:
        return
    if not isinstance(spouse_ids, list):
        raise ValueError("Geçersiz eş listesi.")

    ids = []
    for sid in spouse_ids:
        if sid is None:
            continue
        try:
            sid = int(sid)
        except (TypeError, ValueError):
            raise ValueError("Geçersiz eş kimliği.")
        if sid == person_id:
            raise ValueError("Bir kişi kendi eşi olamaz.")
        if sid not in ids:
            ids.append(sid)

    for sid in ids:
        exists = conn.execute("SELECT id FROM People WHERE id = ?", (sid,)).fetchone()
        if exists is None:
            raise ValueError(f"Eş olarak seçilen kişi ({sid}) bulunamadı.")
        already = conn.execute(
            "SELECT id FROM Spouses WHERE (spouse1Id = ? AND spouse2Id = ?) OR (spouse1Id = ? AND spouse2Id = ?)",
            (person_id, sid, sid, person_id),
        ).fetchone()
        if already is None:
            conn.execute(
                "INSERT INTO Spouses (id, spouse1Id, spouse2Id) VALUES (?, ?, ?)",
                (_next_id(conn, "Spouses"), person_id, sid),
            )


def create_person(fields):
    updates = {k: v for k, v in fields.items() if k in EDITABLE_FIELDS}
    name = str(updates.get("name") or "").strip()
    if not name:
        raise ValueError("Ad boş olamaz.")
    updates["name"] = name
    if "gender" in updates and updates["gender"] not in (0, 1, 2):
        raise ValueError("Geçersiz cinsiyet değeri.")

    parent_ids = fields.get("parentIds")
    spouse_ids = fields.get("spouseIds")

    conn = get_connection()
    try:
        new_id = _next_id(conn, "People")

        columns = ["id"] + list(updates.keys())
        placeholders = ", ".join("?" for _ in columns)
        conn.execute(
            f"INSERT INTO People ({', '.join(columns)}) VALUES ({placeholders})",
            (new_id, *updates.values()),
        )

        if parent_ids:
            _update_parents(conn, new_id, parent_ids)
        _insert_spouses(conn, new_id, spouse_ids)

        conn.commit()

        created = dict(conn.execute("SELECT * FROM People WHERE id = ?", (new_id,)).fetchone())
        parents_row = conn.execute("SELECT parent1Id, parent2Id FROM Parents WHERE childId = ?", (new_id,)).fetchone()
        created["parentIds"] = [pid for pid in (parents_row["parent1Id"], parents_row["parent2Id"]) if pid is not None] if parents_row else []
        spouse_rows = conn.execute("SELECT spouse1Id, spouse2Id FROM Spouses WHERE spouse1Id = ? OR spouse2Id = ?", (new_id, new_id)).fetchall()
        created["spouseIds"] = [(row["spouse2Id"] if row["spouse1Id"] == new_id else row["spouse1Id"]) for row in spouse_rows]
        return created
    finally:
        conn.close()


def delete_person(person_id):
    conn = get_connection()
    try:
        row = conn.execute("SELECT id FROM People WHERE id = ?", (person_id,)).fetchone()
        if row is None:
            raise LookupError("Kişi bulunamadı.")

        # childId is unique per Parents row (one row per child), so key off
        # it rather than Parents.id -- see _next_id's note on why id can't
        # be trusted for rows inserted before this quirk was worked around.
        parent_rows = conn.execute(
            "SELECT childId, parent1Id, parent2Id FROM Parents WHERE parent1Id = ? OR parent2Id = ?",
            (person_id, person_id),
        ).fetchall()
        for prow in parent_rows:
            if prow["parent1Id"] == person_id and prow["parent2Id"] is not None:
                conn.execute(
                    "UPDATE Parents SET parent1Id = ?, parent2Id = NULL WHERE childId = ?",
                    (prow["parent2Id"], prow["childId"]),
                )
            elif prow["parent1Id"] == person_id:
                conn.execute("DELETE FROM Parents WHERE childId = ?", (prow["childId"],))
            else:
                conn.execute("UPDATE Parents SET parent2Id = NULL WHERE childId = ?", (prow["childId"],))

        conn.execute("DELETE FROM Parents WHERE childId = ?", (person_id,))
        conn.execute("DELETE FROM Spouses WHERE spouse1Id = ? OR spouse2Id = ?", (person_id, person_id))
        conn.execute("DELETE FROM People WHERE id = ?", (person_id,))
        conn.commit()
    finally:
        conn.close()


def update_person(person_id, fields):
    parent_ids = fields.get("parentIds")
    updates = {k: v for k, v in fields.items() if k in EDITABLE_FIELDS}
    if not updates and parent_ids is None:
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

        if updates:
            set_clause = ", ".join(f"{key} = ?" for key in updates)
            conn.execute(
                f"UPDATE People SET {set_clause} WHERE id = ?",
                (*updates.values(), person_id),
            )

        if parent_ids is not None:
            _update_parents(conn, person_id, parent_ids)

        conn.commit()

        updated = dict(conn.execute("SELECT * FROM People WHERE id = ?", (person_id,)).fetchone())
        parents_row = conn.execute("SELECT parent1Id, parent2Id FROM Parents WHERE childId = ?", (person_id,)).fetchone()
        updated["parentIds"] = [pid for pid in (parents_row["parent1Id"], parents_row["parent2Id"]) if pid is not None] if parents_row else []
        return updated
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

    def do_POST(self):
        if urlparse(self.path).path != "/api/people":
            self._send_json(404, {"error": "Not found"})
            return

        length = int(self.headers.get("Content-Length", 0) or 0)
        try:
            fields = json.loads(self.rfile.read(length) or b"{}")
            created = create_person(fields)
            self._send_json(201, created)
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def do_DELETE(self):
        match = re.fullmatch(r"/api/people/(\d+)", urlparse(self.path).path)
        if not match:
            self._send_json(404, {"error": "Not found"})
            return

        person_id = int(match.group(1))
        try:
            delete_person(person_id)
            self._send_json(200, {"success": True})
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
