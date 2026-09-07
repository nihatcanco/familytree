#!/usr/bin/env python3
"""Local dev server for the family tree app.

Serves the static frontend (index.html, css/*, js/*) and a small JSON API
backed directly by data.sqlite, so edits made in the UI are written straight
to the database file on disk -- no browser file-write APIs, no downloads.

Run with:
    python3 server.py [port]
"""
import calendar
import email.utils
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from contextlib import contextmanager
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data.sqlite"

# Console output is UTF-8 (the first-run message is Turkish). On Windows the
# console defaults to a legacy code page (cp1252) that can't encode it, which
# would crash on startup, so force UTF-8 and never let an unencodable glyph kill
# the process.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

EDITABLE_FIELDS = {"name", "surname", "gender", "birthdate", "birthplace", "note", "dateofdeath"}

# --- Auth ---------------------------------------------------------------
# Sessions are opaque tokens in a DB table (not signed cookies) so they can
# be revoked server-side (logout, admin removing a user) with a single
# DELETE. SameSite=Strict is the CSRF defense: a cross-site request simply
# never carries the cookie, so state-changing endpoints need no separate
# CSRF token. Set FAMILYTREE_SECURE_COOKIES=1 when this is deployed behind
# an HTTPS reverse proxy (required for real internet exposure -- this
# process itself only ever speaks plain HTTP).
SESSION_COOKIE_NAME = "ft_session"
SESSION_TTL_SECONDS = 7 * 24 * 3600
SECURE_COOKIES = os.environ.get("FAMILYTREE_SECURE_COOKIES") == "1"
ROLES = {"admin", "editor", "viewer"}
EDIT_ROLES = {"admin", "editor"}
ADMIN_ONLY = {"admin"}
PBKDF2_ITERATIONS = 260_000

# ip -> [timestamps of recent failed login attempts], guarded by _login_lock.
_login_failures = {}
_login_lock = threading.Lock()
LOGIN_MAX_ATTEMPTS = 8
LOGIN_WINDOW_SECONDS = 300

# SQLite has no row-level locking and this is a ThreadingHTTPServer, so every
# mutation runs under this single process-wide lock. It also closes the
# read-modify-write race in _next_id() (SELECT MAX(id) then INSERT): without
# it, two concurrent creates compute the same id and the second INSERT hits a
# PRIMARY KEY violation. The tree is tiny and edits are rare, so serialising
# all writes costs nothing noticeable.
_write_lock = threading.RLock()

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".sqlite": "application/x-sqlite3",
}


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # The schema declares ON DELETE CASCADE / SET NULL foreign keys; SQLite
    # ignores them unless this is switched on per connection.
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def db(write=False):
    """A connection that commits on clean exit and always closes. Pass
    write=True for mutations so they serialise on _write_lock (see above)."""
    if write:
        _write_lock.acquire()
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
        if write:
            _write_lock.release()


def ensure_schema():
    """Create tables added after the original data.sqlite was shipped, and
    clean up rows that predate foreign-key enforcement.

    A root is a standalone family-origin marker (a diamond in the UI): it has
    an editable title and an integer generation, and every descendant
    generation is counted from it. People are linked to a root via RootMembers.
    """
    with db(write=True) as conn:
        # An earlier iteration shipped Roots as (id, personId, generation);
        # the current model has no personId. Drop that shape if present.
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(Roots)")}
        if "personId" in cols:
            conn.execute("DROP TABLE Roots")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS Roots (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL DEFAULT 'ROOT',
                generation INT NOT NULL DEFAULT 1
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS RootMembers (
                id INTEGER PRIMARY KEY,
                rootId INT NOT NULL,
                personId INT NOT NULL UNIQUE,
                FOREIGN KEY (rootId) REFERENCES Roots(id) ON DELETE CASCADE,
                FOREIGN KEY (personId) REFERENCES People(id) ON DELETE CASCADE
            )
            """
        )
        # Login accounts. personId links a user to "who they are" in the
        # family tree; it's informational only (nothing in the tree logic
        # depends on it) and is nullable since not every account maps to a
        # person in the tree.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS Users (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                passwordHash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'viewer',
                personId INT,
                createdAt TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (personId) REFERENCES People(id) ON DELETE SET NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS Sessions (
                token TEXT PRIMARY KEY,
                userId INT NOT NULL,
                createdAt TEXT NOT NULL DEFAULT (datetime('now')),
                expiresAt TEXT NOT NULL,
                FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
            )
            """
        )

        # Purge link rows that reference people who no longer exist. These
        # predate foreign-key enforcement; left in place they render as
        # dangling half-edges in the UI and trip PRAGMA foreign_key_check.
        for sql, label in (
            ("DELETE FROM Parents WHERE childId NOT IN (SELECT id FROM People)", "Parents (child)"),
            ("DELETE FROM Parents WHERE parent1Id NOT IN (SELECT id FROM People)", "Parents (parent1)"),
            ("DELETE FROM Parents WHERE parent2Id IS NOT NULL AND parent2Id NOT IN (SELECT id FROM People)", "Parents (parent2)"),
            ("DELETE FROM Spouses WHERE spouse1Id NOT IN (SELECT id FROM People) OR spouse2Id NOT IN (SELECT id FROM People)", "Spouses"),
            ("DELETE FROM RootMembers WHERE personId NOT IN (SELECT id FROM People) OR rootId NOT IN (SELECT id FROM Roots)", "RootMembers"),
        ):
            removed = conn.execute(sql).rowcount
            if removed:
                print(f"  temizlendi: {removed} artık geçersiz {label} bağlantısı silindi")


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password, stored):
    try:
        scheme, iterations, salt_hex, digest_hex = stored.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
    except (ValueError, AttributeError):
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
    return hmac.compare_digest(actual, expected)


def ensure_initial_admin():
    """On a fresh database, create the first admin account and print its
    one-time password to the console -- there is no other account yet that
    could be used to create one via the API."""
    with db(write=True) as conn:
        if conn.execute("SELECT COUNT(*) AS c FROM Users").fetchone()["c"] > 0:
            return
        username = os.environ.get("FAMILYTREE_ADMIN_USERNAME", "admin")
        password = os.environ.get("FAMILYTREE_ADMIN_PASSWORD") or secrets.token_urlsafe(12)
        conn.execute(
            "INSERT INTO Users (username, passwordHash, role, personId) VALUES (?, ?, 'admin', NULL)",
            (username, hash_password(password)),
        )
        print("=" * 64)
        print(" İlk admin hesabı oluşturuldu -- bu bilgiler bir daha gösterilmeyecek:")
        print(f"   Kullanıcı adı : {username}")
        print(f"   Şifre         : {password}")
        print(" Giriş yaptıktan sonra şifrenizi değiştirmeniz önerilir.")
        print("=" * 64)


def _check_rate_limit(ip):
    now = time.time()
    with _login_lock:
        # Drop IPs whose whole window has aged out, so the map can't grow
        # without bound over a long-running process.
        for stale in [k for k, v in _login_failures.items()
                      if not v or now - v[-1] >= LOGIN_WINDOW_SECONDS]:
            if stale != ip:
                del _login_failures[stale]
        attempts = [t for t in _login_failures.get(ip, []) if now - t < LOGIN_WINDOW_SECONDS]
        _login_failures[ip] = attempts
        return len(attempts) < LOGIN_MAX_ATTEMPTS


def _record_login_failure(ip):
    with _login_lock:
        _login_failures.setdefault(ip, []).append(time.time())


def _clear_login_failures(ip):
    with _login_lock:
        _login_failures.pop(ip, None)


def create_session(conn, user_id):
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO Sessions (token, userId, expiresAt) VALUES (?, ?, datetime('now', ?))",
        (token, user_id, f"+{SESSION_TTL_SECONDS} seconds"),
    )
    return token


def get_session_user(conn, token):
    if not token:
        return None
    row = conn.execute(
        """
        SELECT Users.id, Users.username, Users.role, Users.personId
        FROM Sessions JOIN Users ON Users.id = Sessions.userId
        WHERE Sessions.token = ? AND Sessions.expiresAt > datetime('now')
        """,
        (token,),
    ).fetchone()
    return dict(row) if row else None


def login(username, password):
    username = str(username or "").strip()
    with db(write=True) as conn:
        row = conn.execute("SELECT * FROM Users WHERE username = ? COLLATE NOCASE", (username,)).fetchone()
        if row is None or not verify_password(password or "", row["passwordHash"]):
            raise ValueError("Kullanıcı adı veya şifre hatalı.")
        token = create_session(conn, row["id"])
        return token, _user_public(row)


def change_own_password(user_id, current_password, new_password):
    if len(new_password or "") < 8:
        raise ValueError("Yeni şifre en az 8 karakter olmalıdır.")
    with db(write=True) as conn:
        row = conn.execute("SELECT passwordHash FROM Users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise LookupError("Kullanıcı bulunamadı.")
        if not verify_password(current_password or "", row["passwordHash"]):
            raise ValueError("Mevcut şifre yanlış.")
        conn.execute("UPDATE Users SET passwordHash = ? WHERE id = ?", (hash_password(new_password), user_id))


def _user_public(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "personId": row["personId"],
        "createdAt": row["createdAt"],
    }


def _validate_role(role):
    if role not in ROLES:
        raise ValueError("Geçersiz rol.")
    return role


def _validate_person_id(conn, person_id):
    if person_id is None:
        return None
    try:
        person_id = int(person_id)
    except (TypeError, ValueError):
        raise ValueError("Geçersiz kişi kimliği.")
    if conn.execute("SELECT id FROM People WHERE id = ?", (person_id,)).fetchone() is None:
        raise ValueError(f"Kişi ({person_id}) bulunamadı.")
    return person_id


def _last_admin_guard(conn, *, action):
    """Raise if only one admin account remains. `action` is a short Turkish
    verb phrase for the error message ('silinemez' / 'rolü değiştirilemez')."""
    admin_count = conn.execute("SELECT COUNT(*) AS c FROM Users WHERE role = 'admin'").fetchone()["c"]
    if admin_count <= 1:
        raise ValueError(f"Son admin kullanıcısı {action}.")


def list_users():
    with db() as conn:
        return [_user_public(r) for r in conn.execute("SELECT * FROM Users ORDER BY id")]


def create_user(fields):
    username = str(fields.get("username") or "").strip()
    password = str(fields.get("password") or "")
    role = _validate_role(fields.get("role") or "viewer")
    if not username:
        raise ValueError("Kullanıcı adı boş olamaz.")
    if len(password) < 8:
        raise ValueError("Şifre en az 8 karakter olmalıdır.")

    with db(write=True) as conn:
        person_id = _validate_person_id(conn, fields.get("personId"))
        if conn.execute("SELECT id FROM Users WHERE username = ? COLLATE NOCASE", (username,)).fetchone():
            raise ValueError("Bu kullanıcı adı zaten kullanılıyor.")
        cur = conn.execute(
            "INSERT INTO Users (username, passwordHash, role, personId) VALUES (?, ?, ?, ?)",
            (username, hash_password(password), role, person_id),
        )
        return _user_public(conn.execute("SELECT * FROM Users WHERE id = ?", (cur.lastrowid,)).fetchone())


def update_user(user_id, fields):
    with db(write=True) as conn:
        row = conn.execute("SELECT * FROM Users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise LookupError("Kullanıcı bulunamadı.")

        if "username" in fields:
            username = str(fields["username"] or "").strip()
            if not username:
                raise ValueError("Kullanıcı adı boş olamaz.")
            existing = conn.execute(
                "SELECT id FROM Users WHERE username = ? COLLATE NOCASE AND id != ?", (username, user_id)
            ).fetchone()
            if existing:
                raise ValueError("Bu kullanıcı adı zaten kullanılıyor.")
            conn.execute("UPDATE Users SET username = ? WHERE id = ?", (username, user_id))

        if "role" in fields:
            new_role = _validate_role(fields["role"])
            if row["role"] == "admin" and new_role != "admin":
                _last_admin_guard(conn, action="rolü değiştirilemez")
            conn.execute("UPDATE Users SET role = ? WHERE id = ?", (new_role, user_id))

        if "personId" in fields:
            person_id = _validate_person_id(conn, fields["personId"])
            conn.execute("UPDATE Users SET personId = ? WHERE id = ?", (person_id, user_id))

        if fields.get("password"):
            password = str(fields["password"])
            if len(password) < 8:
                raise ValueError("Şifre en az 8 karakter olmalıdır.")
            conn.execute("UPDATE Users SET passwordHash = ? WHERE id = ?", (hash_password(password), user_id))

        return _user_public(conn.execute("SELECT * FROM Users WHERE id = ?", (user_id,)).fetchone())


def delete_user(user_id, acting_user_id):
    if user_id == acting_user_id:
        raise ValueError("Kendi hesabınızı silemezsiniz.")
    with db(write=True) as conn:
        row = conn.execute("SELECT * FROM Users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise LookupError("Kullanıcı bulunamadı.")
        if row["role"] == "admin":
            _last_admin_guard(conn, action="silinemez")
        # Sessions cascade on the Users delete now that foreign_keys is on.
        conn.execute("DELETE FROM Users WHERE id = ?", (user_id,))


def fetch_tree():
    with db() as conn:
        people = [dict(row) for row in conn.execute("SELECT * FROM People")]
        spouses = list(conn.execute("SELECT spouse1Id, spouse2Id FROM Spouses"))
        parents = list(conn.execute("SELECT childId, parent1Id, parent2Id FROM Parents"))
        roots = [dict(row) for row in conn.execute("SELECT id, title, generation FROM Roots ORDER BY id")]
        member_of = {row["personId"]: row["rootId"] for row in conn.execute("SELECT rootId, personId FROM RootMembers")}

    # Group the edge tables by person once, rather than rescanning them per
    # person (was O(people x edges)).
    spouse_map = {}
    for row in spouses:
        a, b = row["spouse1Id"], row["spouse2Id"]
        spouse_map.setdefault(a, []).append(b)
        spouse_map.setdefault(b, []).append(a)
    parent_map = {}
    for row in parents:
        ids = [pid for pid in (row["parent1Id"], row["parent2Id"]) if pid is not None]
        parent_map.setdefault(row["childId"], []).extend(ids)

    for person in people:
        pid = person["id"]
        # Which family root (if any) this person is a founding member of.
        # Generation flows down from that root — see js/tree-model.js.
        person["rootId"] = member_of.get(pid)
        person["spouseIds"] = spouse_map.get(pid, [])
        person["parentIds"] = parent_map.get(pid, [])
    return {"people": people, "roots": roots}


def _ancestor_ids(conn, person_id):
    """All ids reachable by walking up the Parents chain from person_id."""
    seen = set()
    stack = [person_id]
    while stack:
        row = conn.execute(
            "SELECT parent1Id, parent2Id FROM Parents WHERE childId = ?", (stack.pop(),)
        ).fetchone()
        if not row:
            continue
        for pid in (row["parent1Id"], row["parent2Id"]):
            if pid is not None and pid not in seen:
                seen.add(pid)
                stack.append(pid)
    return seen


def _next_id(conn, table):
    # These tables declare "id INT AUTO_INCREMENT" (MySQL-style DDL), which
    # SQLite does NOT treat as a rowid-alias (only the exact type "INTEGER"
    # gets that treatment) -- so ids are never assigned automatically and
    # must be computed explicitly on every insert. The _write_lock held by
    # db(write=True) makes the compute-then-insert safe across threads.
    row = conn.execute(f"SELECT MAX(id) AS max_id FROM {table}").fetchone()
    return (row["max_id"] or 0) + 1


def _coerce_id_list(values, *, self_id, kind):
    """Shared parse+dedupe for parent/spouse/member id lists coming off the
    wire. `kind` is a Turkish noun ('ebeveyn' / 'eş' / 'kişi') for messages."""
    if not isinstance(values, list):
        raise ValueError(f"Geçersiz {kind} listesi.")
    ids = []
    for raw in values:
        if raw is None:
            continue
        try:
            val = int(raw)
        except (TypeError, ValueError):
            raise ValueError(f"Geçersiz {kind} kimliği.")
        if val == self_id:
            raise ValueError(f"Bir kişi kendi {kind}i olamaz.")
        if val not in ids:
            ids.append(val)
    return ids


def _require_people_exist(conn, ids, *, kind):
    for pid in ids:
        if conn.execute("SELECT id FROM People WHERE id = ?", (pid,)).fetchone() is None:
            raise ValueError(f"{kind} olarak seçilen kişi ({pid}) bulunamadı.")


def _update_parents(conn, person_id, parent_ids):
    if not isinstance(parent_ids, list) or len(parent_ids) > 2:
        raise ValueError("Geçersiz ebeveyn listesi.")
    ids = _coerce_id_list(parent_ids, self_id=person_id, kind="ebeveyn")
    if len(ids) > 2:
        raise ValueError("En fazla 2 ebeveyn seçilebilir.")

    for pid in ids:
        if conn.execute("SELECT id FROM People WHERE id = ?", (pid,)).fetchone() is None:
            raise ValueError(f"Ebeveyn olarak seçilen kişi ({pid}) bulunamadı.")
        if person_id in _ancestor_ids(conn, pid):
            raise ValueError("Bu seçim döngüsel bir soy ilişkisi oluşturur.")

    existing = conn.execute("SELECT id FROM Parents WHERE childId = ?", (person_id,)).fetchone()
    if not ids:
        if existing:
            conn.execute("DELETE FROM Parents WHERE childId = ?", (person_id,))
        return

    parent1_id, parent2_id = ids[0], (ids[1] if len(ids) > 1 else None)
    if existing:
        conn.execute(
            "UPDATE Parents SET parent1Id = ?, parent2Id = ? WHERE childId = ?",
            (parent1_id, parent2_id, person_id),
        )
    else:
        conn.execute(
            "INSERT INTO Parents (id, childId, parent1Id, parent2Id) VALUES (?, ?, ?, ?)",
            (_next_id(conn, "Parents"), person_id, parent1_id, parent2_id),
        )


def _set_spouses(conn, person_id, spouse_ids, *, replace):
    """Add the given marriages. With replace=True, also drop any current
    marriage of person_id that isn't in the new list (used by the edit form);
    with replace=False, only ever add (used at person creation)."""
    if spouse_ids is None:
        return
    ids = _coerce_id_list(spouse_ids, self_id=person_id, kind="eş")
    _require_people_exist(conn, ids, kind="Eş")

    existing_rows = conn.execute(
        "SELECT id, spouse1Id, spouse2Id FROM Spouses WHERE spouse1Id = ? OR spouse2Id = ?",
        (person_id, person_id),
    ).fetchall()
    existing_partner_ids = {
        (row["spouse2Id"] if row["spouse1Id"] == person_id else row["spouse1Id"]): row["id"]
        for row in existing_rows
    }

    if replace:
        for partner_id, row_id in existing_partner_ids.items():
            if partner_id not in ids:
                conn.execute("DELETE FROM Spouses WHERE id = ?", (row_id,))

    for sid in ids:
        if sid not in existing_partner_ids:
            conn.execute(
                "INSERT INTO Spouses (id, spouse1Id, spouse2Id) VALUES (?, ?, ?)",
                (_next_id(conn, "Spouses"), person_id, sid),
            )


def _validate_generation(value):
    try:
        value = int(value)
    except (TypeError, ValueError):
        raise ValueError("Jenerasyon bir tam sayı olmalıdır.")
    if value < 1:
        raise ValueError("Jenerasyon 1 veya daha büyük olmalıdır.")
    return value


def _root_dict(conn, root_id):
    row = conn.execute("SELECT id, title, generation FROM Roots WHERE id = ?", (root_id,)).fetchone()
    if row is None:
        raise LookupError("Kök bulunamadı.")
    members = [
        r["personId"]
        for r in conn.execute("SELECT personId FROM RootMembers WHERE rootId = ? ORDER BY personId", (root_id,))
    ]
    return {"id": row["id"], "title": row["title"], "generation": row["generation"], "memberIds": members}


def _set_root_members(conn, root_id, member_ids):
    ids = _coerce_id_list(member_ids, self_id=None, kind="kişi")
    _require_people_exist(conn, ids, kind="Kişi")

    # A person belongs to at most one root: clear this root's current members
    # and any prior membership of the incoming people, then re-insert.
    conn.execute("DELETE FROM RootMembers WHERE rootId = ?", (root_id,))
    for mid in ids:
        conn.execute("DELETE FROM RootMembers WHERE personId = ?", (mid,))
        conn.execute("INSERT INTO RootMembers (rootId, personId) VALUES (?, ?)", (root_id, mid))


def create_root(fields):
    title = str(fields.get("title") or "ROOT").strip() or "ROOT"
    generation = _validate_generation(fields.get("generation", 1))
    member_ids = fields.get("memberIds")
    with db(write=True) as conn:
        cur = conn.execute("INSERT INTO Roots (title, generation) VALUES (?, ?)", (title, generation))
        root_id = cur.lastrowid
        if member_ids is not None:
            _set_root_members(conn, root_id, member_ids)
        return _root_dict(conn, root_id)


def update_root(root_id, fields):
    with db(write=True) as conn:
        if conn.execute("SELECT id FROM Roots WHERE id = ?", (root_id,)).fetchone() is None:
            raise LookupError("Kök bulunamadı.")

        if "title" in fields:
            title = str(fields.get("title") or "ROOT").strip() or "ROOT"
            conn.execute("UPDATE Roots SET title = ? WHERE id = ?", (title, root_id))
        if "generation" in fields:
            conn.execute(
                "UPDATE Roots SET generation = ? WHERE id = ?",
                (_validate_generation(fields.get("generation")), root_id),
            )
        if fields.get("memberIds") is not None:
            _set_root_members(conn, root_id, fields["memberIds"])

        return _root_dict(conn, root_id)


def delete_root(root_id):
    with db(write=True) as conn:
        if conn.execute("SELECT id FROM Roots WHERE id = ?", (root_id,)).fetchone() is None:
            raise LookupError("Kök bulunamadı.")
        # RootMembers cascades on the Roots delete now that foreign_keys is on.
        conn.execute("DELETE FROM Roots WHERE id = ?", (root_id,))


def _clean_person_updates(fields):
    """Pick the editable People columns out of `fields`, normalising name and
    validating gender. Returns the dict to write."""
    updates = {k: v for k, v in fields.items() if k in EDITABLE_FIELDS}
    if "name" in updates:
        name = str(updates.get("name") or "").strip()
        if not name:
            raise ValueError("Ad boş olamaz.")
        updates["name"] = name
    if "gender" in updates and updates["gender"] not in (0, 1, 2):
        raise ValueError("Geçersiz cinsiyet değeri.")
    return updates


def _person_with_links(conn, person_id):
    person = dict(conn.execute("SELECT * FROM People WHERE id = ?", (person_id,)).fetchone())
    parents_row = conn.execute(
        "SELECT parent1Id, parent2Id FROM Parents WHERE childId = ?", (person_id,)
    ).fetchone()
    person["parentIds"] = (
        [pid for pid in (parents_row["parent1Id"], parents_row["parent2Id"]) if pid is not None]
        if parents_row else []
    )
    spouse_rows = conn.execute(
        "SELECT spouse1Id, spouse2Id FROM Spouses WHERE spouse1Id = ? OR spouse2Id = ?",
        (person_id, person_id),
    ).fetchall()
    person["spouseIds"] = [
        (r["spouse2Id"] if r["spouse1Id"] == person_id else r["spouse1Id"]) for r in spouse_rows
    ]
    rm = conn.execute("SELECT rootId FROM RootMembers WHERE personId = ?", (person_id,)).fetchone()
    person["rootId"] = rm["rootId"] if rm else None
    return person


def create_person(fields):
    updates = _clean_person_updates(fields)
    if not str(updates.get("name") or "").strip():
        raise ValueError("Ad boş olamaz.")

    parent_ids = fields.get("parentIds")
    spouse_ids = fields.get("spouseIds")

    with db(write=True) as conn:
        new_id = _next_id(conn, "People")
        columns = ["id"] + list(updates.keys())
        placeholders = ", ".join("?" for _ in columns)
        conn.execute(
            f"INSERT INTO People ({', '.join(columns)}) VALUES ({placeholders})",
            (new_id, *updates.values()),
        )
        if parent_ids:
            _update_parents(conn, new_id, parent_ids)
        _set_spouses(conn, new_id, spouse_ids, replace=False)
        return _person_with_links(conn, new_id)


def delete_person(person_id):
    with db(write=True) as conn:
        if conn.execute("SELECT id FROM People WHERE id = ?", (person_id,)).fetchone() is None:
            raise LookupError("Kişi bulunamadı.")

        # Detach this person from the Parents rows of their *children* first,
        # promoting the co-parent so the child keeps a recorded parent rather
        # than losing the row wholesale (which is what the ON DELETE CASCADE
        # would do). childId is unique per Parents row, so key off it.
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

        # The person's own row + everything keyed to them (their Parents row as
        # a child, Spouses, RootMembers) goes via cascade on the People delete.
        conn.execute("DELETE FROM People WHERE id = ?", (person_id,))


def update_person(person_id, fields):
    parent_ids = fields.get("parentIds")
    spouse_ids = fields.get("spouseIds")
    updates = _clean_person_updates(fields)
    if not updates and parent_ids is None and spouse_ids is None:
        raise ValueError("Düzenlenecek geçerli bir alan gönderilmedi.")

    with db(write=True) as conn:
        if conn.execute("SELECT id FROM People WHERE id = ?", (person_id,)).fetchone() is None:
            raise LookupError("Kişi bulunamadı.")

        if updates:
            set_clause = ", ".join(f"{key} = ?" for key in updates)
            conn.execute(
                f"UPDATE People SET {set_clause} WHERE id = ?",
                (*updates.values(), person_id),
            )
        if parent_ids is not None:
            _update_parents(conn, person_id, parent_ids)
        if spouse_ids is not None:
            _set_spouses(conn, person_id, spouse_ids, replace=True)

        return _person_with_links(conn, person_id)


def _build_session_cookie(token, max_age=SESSION_TTL_SECONDS):
    parts = [f"{SESSION_COOKIE_NAME}={token}", "Path=/", "HttpOnly", "SameSite=Strict", f"Max-Age={max_age}"]
    if SECURE_COOKIES:
        parts.append("Secure")
    return "; ".join(parts)


# --- Routing ----------------------------------------------------------------
# Each JSON endpoint is a (regex, {method: (roles, handler)}) entry. `roles`
# is None for "any logged-in user" or a set of allowed roles; handler is
# called as handler(ctx) and returns (status, payload). ctx carries the
# path-match groups, the parsed body, and the current user.

class _Ctx:
    __slots__ = ("match", "body", "user")

    def __init__(self, match, body, user):
        self.match = match
        self.body = body
        self.user = user

    def group(self, i):
        return int(self.match.group(i))


ROUTES = [
    (re.compile(r"/api/me"), {
        "GET": (None, lambda c: (200, c.user)),
        "PATCH": (None, lambda c: (
            change_own_password(c.user["id"], c.body.get("currentPassword"), c.body.get("password"))
            or (200, {"success": True})
        )),
    }),
    (re.compile(r"/api/tree"), {
        "GET": (None, lambda c: (200, fetch_tree())),
    }),
    (re.compile(r"/api/users"), {
        "GET": (ADMIN_ONLY, lambda c: (200, list_users())),
        "POST": (ADMIN_ONLY, lambda c: (201, create_user(c.body))),
    }),
    (re.compile(r"/api/users/(\d+)"), {
        "PATCH": (ADMIN_ONLY, lambda c: (200, update_user(c.group(1), c.body))),
        "DELETE": (ADMIN_ONLY, lambda c: (delete_user(c.group(1), c.user["id"]) or (200, {"success": True}))),
    }),
    (re.compile(r"/api/people"), {
        "POST": (EDIT_ROLES, lambda c: (201, create_person(c.body))),
    }),
    (re.compile(r"/api/people/(\d+)"), {
        "PATCH": (EDIT_ROLES, lambda c: (200, update_person(c.group(1), c.body))),
        "DELETE": (EDIT_ROLES, lambda c: (delete_person(c.group(1)) or (200, {"success": True}))),
    }),
    (re.compile(r"/api/roots"), {
        "POST": (EDIT_ROLES, lambda c: (201, create_root(c.body))),
    }),
    (re.compile(r"/api/roots/(\d+)"), {
        "PATCH": (EDIT_ROLES, lambda c: (200, update_root(c.group(1), c.body))),
        "DELETE": (EDIT_ROLES, lambda c: (delete_root(c.group(1)) or (200, {"success": True}))),
    }),
]


class Handler(BaseHTTPRequestHandler):
    # -- low-level helpers -------------------------------------------------
    def _send_json(self, status, payload, cookie=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _get_cookie(self, name):
        header = self.headers.get("Cookie")
        if not header:
            return None
        jar = SimpleCookie()
        try:
            jar.load(header)
        except Exception:
            return None
        morsel = jar.get(name)
        return morsel.value if morsel else None

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def _current_user(self):
        token = self._get_cookie(SESSION_COOKIE_NAME)
        if not token:
            return None
        with db() as conn:
            return get_session_user(conn, token)

    # -- auth endpoints (special-cased: no session required) -------------
    def _handle_login(self):
        ip = self.client_address[0]
        if not _check_rate_limit(ip):
            self._send_json(429, {"error": "Çok fazla başarısız deneme yapıldı. Lütfen birkaç dakika sonra tekrar deneyin."})
            return
        try:
            body = self._read_body()
        except (json.JSONDecodeError, ValueError):
            self._send_json(400, {"error": "Geçersiz istek."})
            return
        try:
            token, user = login(body.get("username"), body.get("password"))
        except ValueError as exc:
            _record_login_failure(ip)
            self._send_json(401, {"error": str(exc)})
            return
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})
            return
        _clear_login_failures(ip)
        self._send_json(200, user, cookie=_build_session_cookie(token))

    def _handle_logout(self):
        token = self._get_cookie(SESSION_COOKIE_NAME)
        if token:
            with db(write=True) as conn:
                conn.execute("DELETE FROM Sessions WHERE token = ?", (token,))
        self._send_json(200, {"success": True}, cookie=_build_session_cookie("", max_age=0))

    # -- static files ---------------------------------------------------
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

        # Always revalidate: `no-cache` lets the browser keep a copy but forces
        # an If-Modified-Since check on every load, so a deploy takes effect
        # immediately instead of being masked by heuristic caching. The 304
        # branch keeps that check cheap (no body re-sent).
        mtime = int(candidate.stat().st_mtime)
        ims = self.headers.get("If-Modified-Since")
        parsed = email.utils.parsedate(ims) if ims else None
        if parsed is not None and calendar.timegm(parsed) >= mtime:
            self.send_response(304)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Last-Modified", self.date_time_string(mtime))
            self.end_headers()
            return

        data = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(candidate.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Last-Modified", self.date_time_string(mtime))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    # -- generic JSON dispatch ---------------------------------------------
    def _dispatch_api(self, method, path):
        for pattern, methods in ROUTES:
            m = pattern.fullmatch(path)
            if not m:
                continue
            entry = methods.get(method)
            if entry is None:
                self._send_json(405, {"error": "Method not allowed"})
                return True

            roles, handler = entry
            user = self._current_user()
            if user is None:
                self._send_json(401, {"error": "Oturum açılmamış."})
                return True
            if roles is not None and user["role"] not in roles:
                self._send_json(403, {"error": "Bu işlem için yetkiniz yok."})
                return True

            body = {}
            if method in ("POST", "PATCH", "PUT"):
                try:
                    body = self._read_body()
                except (json.JSONDecodeError, ValueError) as exc:
                    self._send_json(400, {"error": str(exc)})
                    return True

            try:
                status, payload = handler(_Ctx(m, body, user))
                self._send_json(status, payload)
            except LookupError as exc:
                self._send_json(404, {"error": str(exc)})
            except (ValueError, json.JSONDecodeError) as exc:
                self._send_json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001 - surface everything as 500
                self._send_json(500, {"error": str(exc)})
            return True
        return False

    # -- HTTP verbs ------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        if self._dispatch_api("GET", path):
            return
        if path.startswith("/api/"):
            self._send_json(404, {"error": "Not found"})
            return
        # Static files (index.html, css/*, js/*) stay public -- the login
        # screen itself is part of that bundle.
        self._serve_static(path)

    do_HEAD = do_GET

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/login":
            self._handle_login()
            return
        if path == "/api/logout":
            self._handle_logout()
            return
        if not self._dispatch_api("POST", path):
            self._send_json(404, {"error": "Not found"})

    def do_PATCH(self):
        path = urlparse(self.path).path
        if not self._dispatch_api("PATCH", path):
            self._send_json(404, {"error": "Not found"})

    def do_DELETE(self):
        path = urlparse(self.path).path
        if not self._dispatch_api("DELETE", path):
            self._send_json(404, {"error": "Not found"})

    def log_message(self, format_str, *args):
        sys.stderr.write(f"{self.address_string()} - {format_str % args}\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    if not DB_PATH.is_file():
        print(f"data.sqlite not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    ensure_schema()
    ensure_initial_admin()

    host = os.environ.get("FAMILYTREE_HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Family tree server running at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
