#!/usr/bin/env python3
"""Local dev / deploy server for the family tree app.

Serves the static frontend (index.html, css/*, js/*) and a small JSON API
backed by PostgreSQL, so edits made in the UI are written straight to the
database -- no browser file-write APIs, no downloads.

Needs a reachable PostgreSQL; point FAMILYTREE_DATABASE_URL at it (default
postgresql:///familytree). The schema is created on startup (schema.sql), so an
empty database is fine.

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
import sys
import threading
import time
import traceback
from contextlib import contextmanager
from datetime import timedelta
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolTimeout

ROOT = Path(__file__).resolve().parent
SCHEMA_SQL = ROOT / "schema.sql"
DATABASE_URL = os.environ.get("FAMILYTREE_DATABASE_URL", "postgresql:///familytree")

# Console output is UTF-8: on Windows the console defaults to a legacy code
# page (cp1252), and printing anything outside it (a non-ASCII admin username)
# would crash on startup, so force UTF-8 and never let an unencodable glyph kill
# the process. Line-buffered, because stdout is block-buffered when it isn't a
# terminal (a service's log file): the one-time admin password printed on first
# start would otherwise sit unseen in the buffer.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
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

# ip -> [timestamps of recent failed or still-running login attempts], guarded
# by _login_lock.
_login_attempts = {}
_login_lock = threading.Lock()
LOGIN_MAX_ATTEMPTS = 8
LOGIN_WINDOW_SECONDS = 300

# JSON request bodies are a handful of fields; anything bigger is refused
# before it is read, so a bogus Content-Length can't make a worker thread
# buffer gigabytes (/api/login takes a body without any session).
MAX_BODY_BYTES = 1024 * 1024

# Sent on every response: no MIME sniffing, no framing (clickjacking), and no
# Referer leaking the app URL to anything it links to.
SECURITY_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Content-Security-Policy", "frame-ancestors 'none'"),
    ("Referrer-Policy", "no-referrer"),
)

# People / Spouses / Parents ids are handed out by _next_id() (SELECT MAX(id)
# then INSERT), a read-modify-write with no DB-side guard. This is a
# ThreadingHTTPServer, so every mutation runs under this single process-wide
# lock: without it two concurrent creates compute the same id and the second
# INSERT hits a PRIMARY KEY violation. The tree is tiny and edits are rare, so
# serialising all writes costs nothing noticeable.
_write_lock = threading.RLock()

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".txt": "text/plain; charset=utf-8",
}

# Everything else under ROOT (server.py, schema.sql, logs/, .git, README.md,
# tests/, ...) must stay unreachable over HTTP -- only these are the actual
# frontend bundle.
PUBLIC_STATIC_FILES = {"index.html", "version.json", "robots.txt"}
PUBLIC_STATIC_DIRS = {"css", "js"}

# Opened by open_pool() from main() (and lazily on first use, for the test
# harness which imports this module and starts the server in-process). dict_row
# makes every fetch return a plain dict, so `row["col"]` and `dict(row)` both
# work as before.
POOL = ConnectionPool(DATABASE_URL, open=False, max_size=10, kwargs={"row_factory": dict_row})
_pool_lock = threading.Lock()
_pool_opened = False


def open_pool():
    global _pool_opened
    with _pool_lock:
        if not _pool_opened:
            POOL.open(wait=True, timeout=5)
            _pool_opened = True


@contextmanager
def db(write=False):
    """A pooled connection: commits on clean exit, rolls back on error, then
    returns to the pool. Pass write=True for mutations so they serialise on
    _write_lock (see above)."""
    open_pool()
    if write:
        _write_lock.acquire()
    try:
        with POOL.connection() as conn:
            yield conn
    finally:
        if write:
            _write_lock.release()


def ensure_schema():
    """Apply schema.sql (idempotent -- every statement is IF NOT EXISTS).

    A root is a standalone family-origin marker (a diamond in the UI): it has
    an editable title and an integer generation, and every descendant
    generation is counted from it. People are linked to a root via RootMembers.
    """
    with db(write=True) as conn:
        conn.execute(SCHEMA_SQL.read_text())


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


# Checked against when the username doesn't exist, so a failed login costs the
# same PBKDF2 time either way and response timing doesn't reveal which
# usernames are real.
_DUMMY_PASSWORD_HASH = hash_password(secrets.token_urlsafe(16))


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
            "INSERT INTO Users (username, passwordHash, role, personId) VALUES (%s, %s, 'admin', NULL)",
            (username, hash_password(password)),
        )
        print("=" * 64)
        print(" First admin account created -- these details will not be shown again:")
        print(f"   Username : {username}")
        print(f"   Password : {password}")
        print(" Changing the password after logging in is recommended.")
        print("=" * 64)


def _reserve_login_attempt(ip):
    """Count a login attempt against ip *before* its password is checked and
    return its slot, or None if ip is already at the limit. Recording only
    after a failure would let a burst of parallel requests all pass the check
    before any of them was counted. The caller hands the slot back
    (_release_login_attempt) unless the attempt was a wrong password."""
    now = time.time()
    with _login_lock:
        # Drop IPs whose whole window has aged out, so the map can't grow
        # without bound over a long-running process.
        for stale in [k for k, v in _login_attempts.items()
                      if not v or now - v[-1] >= LOGIN_WINDOW_SECONDS]:
            if stale != ip:
                del _login_attempts[stale]
        attempts = [t for t in _login_attempts.get(ip, []) if now - t < LOGIN_WINDOW_SECONDS]
        _login_attempts[ip] = attempts
        if len(attempts) >= LOGIN_MAX_ATTEMPTS:
            return None
        attempts.append(now)
        return now


def _release_login_attempt(ip, slot):
    # Only this attempt's own slot: a successful login doesn't wipe the
    # failures before it, or interleaving logins to a known account would
    # reset the limit.
    with _login_lock:
        attempts = _login_attempts.get(ip)
        if attempts and slot in attempts:
            attempts.remove(slot)


def create_session(conn, user_id):
    # Expired rows are never read again; sweep them here so the table doesn't
    # grow forever.
    conn.execute("DELETE FROM Sessions WHERE expiresAt <= now()")
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO Sessions (token, userId, expiresAt) VALUES (%s, %s, now() + %s)",
        (token, user_id, timedelta(seconds=SESSION_TTL_SECONDS)),
    )
    return token


def get_session_user(conn, token):
    if not token:
        return None
    row = conn.execute(
        """
        SELECT Users.id, Users.username, Users.role, Users.personId AS "personId"
        FROM Sessions JOIN Users ON Users.id = Sessions.userId
        WHERE Sessions.token = %s AND Sessions.expiresAt > now()
        """,
        (token,),
    ).fetchone()
    return dict(row) if row else None


def revoke_sessions(conn, user_id, keep_token=None):
    """Log user_id out everywhere except keep_token (the caller's own session,
    if any) -- after a password change, a session opened with the old
    password must not keep working."""
    conn.execute(
        "DELETE FROM Sessions WHERE userId = %s AND token IS DISTINCT FROM %s",
        (user_id, keep_token),
    )


def login(username, password):
    username = str(username or "").strip()
    # No write lock (a session row needs no _next_id()), and no pooled
    # connection held during the deliberately slow PBKDF2 check: otherwise a
    # stream of login attempts would stall every edit and drain the pool.
    with db() as conn:
        row = conn.execute("SELECT * FROM Users WHERE lower(username) = lower(%s)", (username,)).fetchone()
    stored = row["passwordhash"] if row else _DUMMY_PASSWORD_HASH
    if not verify_password(str(password or ""), stored) or row is None:
        raise ValueError("Incorrect username or password.")
    with db() as conn:
        token = create_session(conn, row["id"])
    return token, _user_public(row)


def change_own_password(user_id, current_password, new_password, keep_token=None):
    if len(new_password or "") < 8:
        raise ValueError("The new password must be at least 8 characters.")
    with db(write=True) as conn:
        row = conn.execute("SELECT passwordHash FROM Users WHERE id = %s", (user_id,)).fetchone()
        if row is None:
            raise LookupError("User not found.")
        if not verify_password(current_password or "", row["passwordhash"]):
            raise ValueError("The current password is incorrect.")
        conn.execute("UPDATE Users SET passwordHash = %s WHERE id = %s", (hash_password(new_password), user_id))
        revoke_sessions(conn, user_id, keep_token)


def _user_public(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "personId": row["personid"],
        "createdAt": row["createdat"],
    }


def _validate_role(role):
    if role not in ROLES:
        raise ValueError("Invalid role.")
    return role


def _validate_person_id(conn, person_id):
    if person_id is None:
        return None
    try:
        person_id = int(person_id)
    except (TypeError, ValueError):
        raise ValueError("Invalid person id.")
    if conn.execute("SELECT id FROM People WHERE id = %s", (person_id,)).fetchone() is None:
        raise ValueError(f"Person ({person_id}) not found.")
    return person_id


def _last_admin_guard(conn, *, action):
    """Raise if only one admin account remains. `action` is a short verb
    phrase completing the (user-facing) error message, e.g. "cannot be deleted"."""
    admin_count = conn.execute("SELECT COUNT(*) AS c FROM Users WHERE role = 'admin'").fetchone()["c"]
    if admin_count <= 1:
        raise ValueError(f"The last admin user {action}.")


def list_users():
    with db() as conn:
        return [_user_public(r) for r in conn.execute("SELECT * FROM Users ORDER BY id")]


def create_user(fields):
    username = str(fields.get("username") or "").strip()
    password = str(fields.get("password") or "")
    role = _validate_role(fields.get("role") or "viewer")
    if not username:
        raise ValueError("Username cannot be empty.")
    if len(password) < 8:
        raise ValueError("The password must be at least 8 characters.")

    with db(write=True) as conn:
        person_id = _validate_person_id(conn, fields.get("personId"))
        if conn.execute("SELECT id FROM Users WHERE lower(username) = lower(%s)", (username,)).fetchone():
            raise ValueError("This username is already taken.")
        new_id = conn.execute(
            "INSERT INTO Users (username, passwordHash, role, personId) VALUES (%s, %s, %s, %s) RETURNING id",
            (username, hash_password(password), role, person_id),
        ).fetchone()["id"]
        return _user_public(conn.execute("SELECT * FROM Users WHERE id = %s", (new_id,)).fetchone())


def update_user(user_id, fields, keep_token=None):
    with db(write=True) as conn:
        row = conn.execute("SELECT * FROM Users WHERE id = %s", (user_id,)).fetchone()
        if row is None:
            raise LookupError("User not found.")

        if "username" in fields:
            username = str(fields["username"] or "").strip()
            if not username:
                raise ValueError("Username cannot be empty.")
            existing = conn.execute(
                "SELECT id FROM Users WHERE lower(username) = lower(%s) AND id != %s", (username, user_id)
            ).fetchone()
            if existing:
                raise ValueError("This username is already taken.")
            conn.execute("UPDATE Users SET username = %s WHERE id = %s", (username, user_id))

        if "role" in fields:
            new_role = _validate_role(fields["role"])
            if row["role"] == "admin" and new_role != "admin":
                _last_admin_guard(conn, action="cannot have its role changed")
            conn.execute("UPDATE Users SET role = %s WHERE id = %s", (new_role, user_id))

        if "personId" in fields:
            person_id = _validate_person_id(conn, fields["personId"])
            conn.execute("UPDATE Users SET personId = %s WHERE id = %s", (person_id, user_id))

        if fields.get("password"):
            password = str(fields["password"])
            if len(password) < 8:
                raise ValueError("The password must be at least 8 characters.")
            conn.execute("UPDATE Users SET passwordHash = %s WHERE id = %s", (hash_password(password), user_id))
            revoke_sessions(conn, user_id, keep_token)

        return _user_public(conn.execute("SELECT * FROM Users WHERE id = %s", (user_id,)).fetchone())


def delete_user(user_id, acting_user_id):
    if user_id == acting_user_id:
        raise ValueError("You cannot delete your own account.")
    with db(write=True) as conn:
        row = conn.execute("SELECT * FROM Users WHERE id = %s", (user_id,)).fetchone()
        if row is None:
            raise LookupError("User not found.")
        if row["role"] == "admin":
            _last_admin_guard(conn, action="cannot be deleted")
        # Sessions cascade on the Users delete (Postgres enforces the FK).
        conn.execute("DELETE FROM Users WHERE id = %s", (user_id,))


def fetch_tree():
    with db() as conn:
        people = [dict(row) for row in conn.execute("SELECT * FROM People")]
        spouses = list(conn.execute("SELECT spouse1Id, spouse2Id FROM Spouses"))
        parents = list(conn.execute("SELECT childId, parent1Id, parent2Id FROM Parents"))
        roots = [dict(row) for row in conn.execute("SELECT id, title, generation FROM Roots ORDER BY id")]
        member_of = {row["personid"]: row["rootid"] for row in conn.execute("SELECT rootId, personId FROM RootMembers")}

    # Group the edge tables by person once, rather than rescanning them per
    # person (was O(people x edges)).
    spouse_map = {}
    for row in spouses:
        a, b = row["spouse1id"], row["spouse2id"]
        spouse_map.setdefault(a, []).append(b)
        spouse_map.setdefault(b, []).append(a)
    parent_map = {}
    for row in parents:
        ids = [pid for pid in (row["parent1id"], row["parent2id"]) if pid is not None]
        parent_map.setdefault(row["childid"], []).extend(ids)

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
            "SELECT parent1Id, parent2Id FROM Parents WHERE childId = %s", (stack.pop(),)
        ).fetchone()
        if not row:
            continue
        for pid in (row["parent1id"], row["parent2id"]):
            if pid is not None and pid not in seen:
                seen.add(pid)
                stack.append(pid)
    return seen


def _next_id(conn, table):
    # People / Spouses / Parents ids are plain integer PKs with no identity or
    # sequence (see schema.sql), so every insert computes the next one itself.
    # The _write_lock held by db(write=True) makes the compute-then-insert safe
    # across threads.
    row = conn.execute(f"SELECT MAX(id) AS max_id FROM {table}").fetchone()
    return (row["max_id"] or 0) + 1


def _coerce_id_list(values, *, self_id, kind):
    """Shared parse+dedupe for parent/spouse/member id lists coming off the
    wire. `kind` names the relation (parent / spouse / person)
    in the user-facing error messages."""
    if not isinstance(values, list):
        raise ValueError(f"Invalid {kind} list.")
    ids = []
    for raw in values:
        if raw is None:
            continue
        try:
            val = int(raw)
        except (TypeError, ValueError):
            raise ValueError(f"Invalid {kind} id.")
        if val == self_id:
            raise ValueError(f"A person cannot be their own {kind}.")
        if val not in ids:
            ids.append(val)
    return ids


def _require_people_exist(conn, ids, *, kind):
    for pid in ids:
        if conn.execute("SELECT id FROM People WHERE id = %s", (pid,)).fetchone() is None:
            raise ValueError(f"The person selected as {kind} ({pid}) was not found.")


def _update_parents(conn, person_id, parent_ids):
    if not isinstance(parent_ids, list) or len(parent_ids) > 2:
        raise ValueError("Invalid parent list.")
    ids = _coerce_id_list(parent_ids, self_id=person_id, kind="parent")

    for pid in ids:
        if conn.execute("SELECT id FROM People WHERE id = %s", (pid,)).fetchone() is None:
            raise ValueError(f"The person selected as parent ({pid}) was not found.")
        if person_id in _ancestor_ids(conn, pid):
            raise ValueError("This choice would create a circular ancestry.")

    existing = conn.execute("SELECT id FROM Parents WHERE childId = %s", (person_id,)).fetchone()
    if not ids:
        if existing:
            conn.execute("DELETE FROM Parents WHERE childId = %s", (person_id,))
        return

    parent1_id, parent2_id = ids[0], (ids[1] if len(ids) > 1 else None)
    if existing:
        conn.execute(
            "UPDATE Parents SET parent1Id = %s, parent2Id = %s WHERE childId = %s",
            (parent1_id, parent2_id, person_id),
        )
    else:
        conn.execute(
            "INSERT INTO Parents (id, childId, parent1Id, parent2Id) VALUES (%s, %s, %s, %s)",
            (_next_id(conn, "Parents"), person_id, parent1_id, parent2_id),
        )


def _set_spouses(conn, person_id, spouse_ids, *, replace):
    """Add the given marriages. With replace=True, also drop any current
    marriage of person_id that isn't in the new list (used by the edit form);
    with replace=False, only ever add (used at person creation)."""
    if spouse_ids is None:
        return
    ids = _coerce_id_list(spouse_ids, self_id=person_id, kind="spouse")
    _require_people_exist(conn, ids, kind="spouse")

    existing_rows = conn.execute(
        "SELECT id, spouse1Id, spouse2Id FROM Spouses WHERE spouse1Id = %s OR spouse2Id = %s",
        (person_id, person_id),
    ).fetchall()
    existing_partner_ids = {
        (row["spouse2id"] if row["spouse1id"] == person_id else row["spouse1id"]): row["id"]
        for row in existing_rows
    }

    if replace:
        for partner_id, row_id in existing_partner_ids.items():
            if partner_id not in ids:
                conn.execute("DELETE FROM Spouses WHERE id = %s", (row_id,))

    for sid in ids:
        if sid not in existing_partner_ids:
            conn.execute(
                "INSERT INTO Spouses (id, spouse1Id, spouse2Id) VALUES (%s, %s, %s)",
                (_next_id(conn, "Spouses"), person_id, sid),
            )


def _validate_generation(value):
    try:
        value = int(value)
    except (TypeError, ValueError):
        raise ValueError("Generation must be a whole number.")
    if value < 1:
        raise ValueError("Generation must be 1 or more.")
    return value


def _root_dict(conn, root_id):
    row = conn.execute("SELECT id, title, generation FROM Roots WHERE id = %s", (root_id,)).fetchone()
    if row is None:
        raise LookupError("Root not found.")
    members = [
        r["personid"]
        for r in conn.execute("SELECT personId FROM RootMembers WHERE rootId = %s ORDER BY personId", (root_id,))
    ]
    return {"id": row["id"], "title": row["title"], "generation": row["generation"], "memberIds": members}


def _set_root_members(conn, root_id, member_ids):
    ids = _coerce_id_list(member_ids, self_id=None, kind="member")
    _require_people_exist(conn, ids, kind="member")

    # A person belongs to at most one root: clear this root's current members
    # and any prior membership of the incoming people, then re-insert.
    conn.execute("DELETE FROM RootMembers WHERE rootId = %s", (root_id,))
    for mid in ids:
        conn.execute("DELETE FROM RootMembers WHERE personId = %s", (mid,))
        conn.execute("INSERT INTO RootMembers (rootId, personId) VALUES (%s, %s)", (root_id, mid))


def create_root(fields):
    title = str(fields.get("title") or "ROOT").strip() or "ROOT"
    generation = _validate_generation(fields.get("generation", 1))
    member_ids = fields.get("memberIds")
    with db(write=True) as conn:
        root_id = conn.execute(
            "INSERT INTO Roots (title, generation) VALUES (%s, %s) RETURNING id", (title, generation)
        ).fetchone()["id"]
        if member_ids is not None:
            _set_root_members(conn, root_id, member_ids)
        return _root_dict(conn, root_id)


def update_root(root_id, fields):
    with db(write=True) as conn:
        if conn.execute("SELECT id FROM Roots WHERE id = %s", (root_id,)).fetchone() is None:
            raise LookupError("Root not found.")

        if "title" in fields:
            title = str(fields.get("title") or "ROOT").strip() or "ROOT"
            conn.execute("UPDATE Roots SET title = %s WHERE id = %s", (title, root_id))
        if "generation" in fields:
            conn.execute(
                "UPDATE Roots SET generation = %s WHERE id = %s",
                (_validate_generation(fields.get("generation")), root_id),
            )
        if fields.get("memberIds") is not None:
            _set_root_members(conn, root_id, fields["memberIds"])

        return _root_dict(conn, root_id)


def delete_root(root_id):
    with db(write=True) as conn:
        if conn.execute("SELECT id FROM Roots WHERE id = %s", (root_id,)).fetchone() is None:
            raise LookupError("Root not found.")
        # RootMembers cascades on the Roots delete (Postgres enforces the FK).
        conn.execute("DELETE FROM Roots WHERE id = %s", (root_id,))


def _clean_person_updates(fields):
    """Pick the editable People columns out of `fields`, normalising name and
    validating gender. Returns the dict to write."""
    updates = {k: v for k, v in fields.items() if k in EDITABLE_FIELDS}
    if "name" in updates:
        name = str(updates.get("name") or "").strip()
        if not name:
            raise ValueError("Name cannot be empty.")
        updates["name"] = name
    if "gender" in updates and updates["gender"] not in (0, 1, 2):
        raise ValueError("Invalid gender value.")
    return updates


def _person_with_links(conn, person_id):
    person = dict(conn.execute("SELECT * FROM People WHERE id = %s", (person_id,)).fetchone())
    parents_row = conn.execute(
        "SELECT parent1Id, parent2Id FROM Parents WHERE childId = %s", (person_id,)
    ).fetchone()
    person["parentIds"] = (
        [pid for pid in (parents_row["parent1id"], parents_row["parent2id"]) if pid is not None]
        if parents_row else []
    )
    spouse_rows = conn.execute(
        "SELECT spouse1Id, spouse2Id FROM Spouses WHERE spouse1Id = %s OR spouse2Id = %s",
        (person_id, person_id),
    ).fetchall()
    person["spouseIds"] = [
        (r["spouse2id"] if r["spouse1id"] == person_id else r["spouse1id"]) for r in spouse_rows
    ]
    rm = conn.execute("SELECT rootId FROM RootMembers WHERE personId = %s", (person_id,)).fetchone()
    person["rootId"] = rm["rootid"] if rm else None
    return person


def create_person(fields):
    updates = _clean_person_updates(fields)
    if not str(updates.get("name") or "").strip():
        raise ValueError("Name cannot be empty.")

    parent_ids = fields.get("parentIds")
    spouse_ids = fields.get("spouseIds")

    with db(write=True) as conn:
        new_id = _next_id(conn, "People")
        columns = ["id"] + list(updates.keys())
        placeholders = ", ".join("%s" for _ in columns)
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
        if conn.execute("SELECT id FROM People WHERE id = %s", (person_id,)).fetchone() is None:
            raise LookupError("Person not found.")

        # Detach this person from the Parents rows of their *children* first,
        # promoting the co-parent so the child keeps a recorded parent rather
        # than losing the row wholesale (which is what the ON DELETE CASCADE
        # would do). childId is unique per Parents row, so key off it.
        parent_rows = conn.execute(
            "SELECT childId, parent1Id, parent2Id FROM Parents WHERE parent1Id = %s OR parent2Id = %s",
            (person_id, person_id),
        ).fetchall()
        for prow in parent_rows:
            if prow["parent1id"] == person_id and prow["parent2id"] is not None:
                conn.execute(
                    "UPDATE Parents SET parent1Id = %s, parent2Id = NULL WHERE childId = %s",
                    (prow["parent2id"], prow["childid"]),
                )
            elif prow["parent1id"] == person_id:
                conn.execute("DELETE FROM Parents WHERE childId = %s", (prow["childid"],))
            else:
                conn.execute("UPDATE Parents SET parent2Id = NULL WHERE childId = %s", (prow["childid"],))

        # The person's own row + everything keyed to them (their Parents row as
        # a child, Spouses, RootMembers) goes via cascade on the People delete.
        conn.execute("DELETE FROM People WHERE id = %s", (person_id,))


def update_person(person_id, fields):
    parent_ids = fields.get("parentIds")
    spouse_ids = fields.get("spouseIds")
    updates = _clean_person_updates(fields)
    if not updates and parent_ids is None and spouse_ids is None:
        raise ValueError("No valid field to update was sent.")

    with db(write=True) as conn:
        if conn.execute("SELECT id FROM People WHERE id = %s", (person_id,)).fetchone() is None:
            raise LookupError("Person not found.")

        if updates:
            set_clause = ", ".join(f"{key} = %s" for key in updates)
            conn.execute(
                f"UPDATE People SET {set_clause} WHERE id = %s",
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
# path-match groups, the parsed body, the current user and their session token.

class _Ctx:
    __slots__ = ("match", "body", "user", "token")

    def __init__(self, match, body, user, token):
        self.match = match
        self.body = body
        self.user = user
        self.token = token

    def group(self, i):
        return int(self.match.group(i))


ROUTES = [
    (re.compile(r"/api/me"), {
        "GET": (None, lambda c: (200, c.user)),
        "PATCH": (None, lambda c: (
            change_own_password(c.user["id"], c.body.get("currentPassword"), c.body.get("password"), c.token)
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
        "PATCH": (ADMIN_ONLY, lambda c: (200, update_user(c.group(1), c.body, c.token))),
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
    def end_headers(self):
        for name, value in SECURITY_HEADERS:
            self.send_header(name, value)
        super().end_headers()

    def _send_server_error(self):
        # The details (SQL, connection info) go to the log, not the client.
        traceback.print_exc()
        self._send_json(500, {"error": "Server error."})

    def _send_json(self, status, payload, cookie=None):
        # default=str: createdAt comes back from Postgres as a datetime.
        body = json.dumps(payload, default=str).encode("utf-8")
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
        if length < 0 or length > MAX_BODY_BYTES:
            raise ValueError("Invalid request size.")
        body = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(body, dict):
            raise ValueError("Invalid request.")
        return body

    def _current_user(self, token):
        if not token:
            return None
        with db() as conn:
            return get_session_user(conn, token)

    # -- auth endpoints (special-cased: no session required) -------------
    def _handle_login(self):
        ip = self.client_address[0]
        slot = _reserve_login_attempt(ip)
        if slot is None:
            self._send_json(429, {"error": "Too many failed attempts. Please try again in a few minutes."})
            return
        try:
            body = self._read_body()
        except (json.JSONDecodeError, ValueError):
            _release_login_attempt(ip, slot)
            self._send_json(400, {"error": "Invalid request."})
            return
        try:
            token, user = login(body.get("username"), body.get("password"))
        except ValueError as exc:
            # A wrong password keeps its slot: that's what the limit counts.
            self._send_json(401, {"error": str(exc)})
            return
        except Exception:
            _release_login_attempt(ip, slot)
            self._send_server_error()
            return
        _release_login_attempt(ip, slot)
        self._send_json(200, user, cookie=_build_session_cookie(token))

    def _handle_logout(self):
        token = self._get_cookie(SESSION_COOKIE_NAME)
        if token:
            with db(write=True) as conn:
                conn.execute("DELETE FROM Sessions WHERE token = %s", (token,))
        self._send_json(200, {"success": True}, cookie=_build_session_cookie("", max_age=0))

    # -- static files ---------------------------------------------------
    def _serve_static(self, url_path):
        if url_path == "/":
            url_path = "/index.html"
        candidate = (ROOT / url_path.lstrip("/")).resolve()
        if candidate != ROOT and ROOT not in candidate.parents:
            self._send_json(403, {"error": "Forbidden"})
            return
        # Allowlist, not a traversal blacklist: only the actual frontend
        # bundle is reachable, so app source, schema.sql, logs/, .git etc.
        # sitting next to server.py can never be requested over HTTP -- checked
        # against the *resolved* path so "/css/../server.py" can't sneak by.
        parts = candidate.relative_to(ROOT).parts
        is_public = (len(parts) == 1 and parts[0] in PUBLIC_STATIC_FILES) or (
            len(parts) >= 2 and parts[0] in PUBLIC_STATIC_DIRS
        )
        if not is_public:
            self._send_json(404, {"error": "Not found"})
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
            token = self._get_cookie(SESSION_COOKIE_NAME)
            user = self._current_user(token)
            if user is None:
                self._send_json(401, {"error": "Not logged in."})
                return True
            if roles is not None and user["role"] not in roles:
                self._send_json(403, {"error": "You are not allowed to do this."})
                return True

            body = {}
            if method in ("POST", "PATCH", "PUT"):
                try:
                    body = self._read_body()
                except (json.JSONDecodeError, ValueError) as exc:
                    self._send_json(400, {"error": str(exc)})
                    return True

            try:
                status, payload = handler(_Ctx(m, body, user, token))
                self._send_json(status, payload)
            except LookupError as exc:
                self._send_json(404, {"error": str(exc)})
            except (ValueError, json.JSONDecodeError) as exc:
                self._send_json(400, {"error": str(exc)})
            except Exception:  # noqa: BLE001 - surface everything as 500
                self._send_server_error()
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


class Server(ThreadingHTTPServer):
    # socketserver's default listen backlog is 5. Every request opens its own
    # connection (HTTP/1.0) and one page load fetches a dozen files, so a burst
    # of connections could be refused (reset on macOS, SYN-retry delays on
    # Linux) before the accept loop catches up.
    request_queue_size = 128


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    try:
        open_pool()
        with db() as conn:
            conn.execute("SELECT 1")
    except (psycopg.OperationalError, PoolTimeout) as exc:
        print(f"cannot reach PostgreSQL at {DATABASE_URL!r}: {exc}", file=sys.stderr)
        print("check FAMILYTREE_DATABASE_URL and that the database/role exist.", file=sys.stderr)
        sys.exit(1)

    ensure_schema()
    ensure_initial_admin()

    host = os.environ.get("FAMILYTREE_HOST", "127.0.0.1")
    server = Server((host, port), Handler)
    print(f"Family tree server running at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
