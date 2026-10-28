"""Integration smoke test for server.py.

Runs the real server against a freshly reset PostgreSQL database (see
tests/pg_fixture.py) on a random port and exercises every endpoint.
Run: python3 tests/test_api.py
"""
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pg_fixture import reset_and_seed  # noqa: E402


HOST = "127.0.0.1"


def free_port():
    s = socket.socket()
    s.bind((HOST, 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Client:
    def __init__(self, port):
        self.port = port
        self.cookie = None

    def req(self, method, path, body=None):
        conn = http.client.HTTPConnection(HOST, self.port, timeout=5)
        headers = {"Content-Type": "application/json"}
        if self.cookie:
            headers["Cookie"] = self.cookie
        conn.request(method, path, json.dumps(body) if body is not None else None, headers)
        resp = conn.getresponse()
        raw = resp.read()
        sc = resp.getheader("Set-Cookie")
        if sc:
            self.cookie = sc.split(";")[0]
        conn.close()
        data = json.loads(raw) if raw and resp.getheader("Content-Type", "").startswith("application/json") else raw
        return resp.status, data


PASS = FAIL = 0


def check(label, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {label}")
    else:
        FAIL += 1
        print(f"  FAIL {label} {extra}")


def main():
    tmp = tempfile.mkdtemp()
    # Fresh schema + data in Postgres; accounts wiped so ensure_initial_admin()
    # creates one with a known password.
    database_url = reset_and_seed()
    port = free_port()

    env = {**os.environ, "FAMILYTREE_ADMIN_USERNAME": "admin", "FAMILYTREE_ADMIN_PASSWORD": "testpass123",
           "FAMILYTREE_DATABASE_URL": database_url}
    # Run a copy of server.py from a temp dir (it resolves schema.sql / static
    # assets relative to its own location).
    server_py = (Path(tmp) / "server.py")
    shutil.copy(ROOT / "server.py", server_py)
    shutil.copy(ROOT / "schema.sql", Path(tmp) / "schema.sql")
    shutil.copy(ROOT / "index.html", Path(tmp) / "index.html")
    shutil.copy(ROOT / "robots.txt", Path(tmp) / "robots.txt")
    shutil.copytree(ROOT / "js", Path(tmp) / "js")
    shutil.copytree(ROOT / "css", Path(tmp) / "css")
    proc = subprocess.Popen(
        [sys.executable, str(server_py), str(port)],
        cwd=tmp, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        up = False
        for _ in range(100):
            if proc.poll() is not None:
                break
            try:
                http.client.HTTPConnection(HOST, port, timeout=1).request("GET", "/api/me")
                up = True
                break
            except OSError:
                time.sleep(0.1)
        if not up:
            print("server did not start; output follows:\n" + (proc.stdout.read() if proc.stdout else ""))
            raise SystemExit(1)

        c = Client(port)

        s, _ = c.req("GET", "/api/me")
        check("unauthenticated /api/me -> 401", s == 401, s)

        s, _ = c.req("GET", "/api/tree")
        check("unauthenticated /api/tree -> 401", s == 401, s)

        s, d = c.req("POST", "/api/login", {"username": "admin", "password": "wrong"})
        check("bad login -> 401", s == 401, s)

        s, user = c.req("POST", "/api/login", {"username": "admin", "password": "testpass123"})
        check("good login -> 200", s == 200 and user["role"] == "admin", (s, user))

        s, tree = c.req("GET", "/api/tree")
        check("tree loads", s == 200 and len(tree["people"]) >= 15 and "roots" in tree, s)
        person0 = tree["people"][0]
        check("person has link arrays", isinstance(person0.get("spouseIds"), list) and isinstance(person0.get("parentIds"), list))

        # --- person CRUD ---
        s, created = c.req("POST", "/api/people", {"name": "Test Person", "gender": 1})
        check("create person -> 201", s == 201 and created["name"] == "Test Person", (s, created))
        new_id = created["id"]

        s, tr = c.req("POST", "/api/people", {"name": "Şükrü İğdeli", "surname": "Çağlayan Öztürk", "birthplace": "Iğdır"})
        check("Turkish characters round-trip", s == 201 and tr["name"] == "Şükrü İğdeli"
              and tr.get("surname") == "Çağlayan Öztürk"
              and tr.get("birthplace") == "Iğdır", (s, tr))
        c.req("DELETE", f"/api/people/{tr['id']}")

        s, tree2 = c.req("GET", "/api/tree")
        check("new person id is unique + max+1", new_id == max(p["id"] for p in tree["people"]) + 1, new_id)

        s, updated = c.req("PATCH", f"/api/people/{new_id}", {"name": "Test Person 2", "note": "a note"})
        check("update person -> 200", s == 200 and updated["name"] == "Test Person 2", (s, updated))

        s, updated = c.req("PATCH", f"/api/people/{new_id}", {"parentIds": [person0["id"]]})
        check("set parent -> 200", s == 200 and updated["parentIds"] == [person0["id"]], (s, updated))

        s, d = c.req("PATCH", f"/api/people/{new_id}", {"parentIds": [new_id]})
        check("self-parent rejected -> 400", s == 400, (s, d))

        s, d = c.req("PATCH", f"/api/people/{person0['id']}", {"parentIds": [new_id]})
        check("cycle rejected -> 400", s == 400, (s, d))

        s, spoused = c.req("PATCH", f"/api/people/{new_id}", {"spouseIds": [person0["id"]]})
        check("set spouse -> 200", s == 200 and person0["id"] in spoused["spouseIds"], (s, spoused))
        s, spoused = c.req("PATCH", f"/api/people/{new_id}", {"spouseIds": []})
        check("clear spouse -> 200", s == 200 and spoused["spouseIds"] == [], (s, spoused))

        # --- root CRUD ---
        s, root = c.req("POST", "/api/roots", {"title": "TEST ROOT", "generation": 2, "memberIds": [new_id]})
        check("create root -> 201", s == 201 and root["memberIds"] == [new_id], (s, root))
        rid = root["id"]
        s, root = c.req("PATCH", f"/api/roots/{rid}", {"generation": 3})
        check("update root -> 200", s == 200 and root["generation"] == 3, (s, root))
        s, d = c.req("PATCH", f"/api/roots/{rid}", {"generation": 0})
        check("bad generation -> 400", s == 400, (s, d))
        s, d = c.req("DELETE", f"/api/roots/{rid}")
        check("delete root -> 200", s == 200, (s, d))
        s, tree3 = c.req("GET", "/api/tree")
        check("root gone + members cascade-cleared", all(r["id"] != rid for r in tree3["roots"]), rid)

        # --- users ---
        s, users = c.req("GET", "/api/users")
        check("list users", s == 200 and len(users) == 1, (s, users))
        s, nu = c.req("POST", "/api/users", {"username": "editor1", "password": "editorpass1", "role": "editor"})
        check("create user -> 201", s == 201 and nu["role"] == "editor", (s, nu))
        s, d = c.req("POST", "/api/users", {"username": "x", "password": "short", "role": "viewer"})
        check("short password rejected -> 400", s == 400, (s, d))
        s, d = c.req("PATCH", "/api/users/1", {"role": "viewer"})
        check("demoting last admin rejected -> 400", s == 400, (s, d))
        s, d = c.req("DELETE", "/api/users/1")
        check("deleting self rejected -> 400", s == 400, (s, d))
        s, d = c.req("DELETE", f"/api/users/{nu['id']}")
        check("delete other user -> 200", s == 200, (s, d))

        # --- editor role can't touch users ---
        ec = Client(port)
        ec.req("POST", "/api/users", None)  # ensure editor exists again
        s, nu2 = c.req("POST", "/api/users", {"username": "editor2", "password": "editorpass2", "role": "editor"})
        s, _ = ec.req("POST", "/api/login", {"username": "editor2", "password": "editorpass2"})
        s, d = ec.req("GET", "/api/users")
        check("editor forbidden from /api/users -> 403", s == 403, (s, d))
        s, d = ec.req("POST", "/api/people", {"name": "Added By Editor"})
        check("editor can create person -> 201", s == 201, (s, d))

        # --- a password change logs out every other session ---
        ec2 = Client(port)
        ec2.req("POST", "/api/login", {"username": "editor2", "password": "editorpass2"})
        s, d = ec.req("PATCH", "/api/me", {"currentPassword": "editorpass2", "password": "editorpass3"})
        check("change own password -> 200", s == 200, (s, d))
        s, _ = ec.req("GET", "/api/me")
        check("own session survives own password change", s == 200, s)
        s, _ = ec2.req("GET", "/api/me")
        check("other session revoked by password change -> 401", s == 401, s)
        s, d = c.req("PATCH", f"/api/users/{nu2['id']}", {"password": "adminreset1"})
        check("admin password reset -> 200", s == 200, (s, d))
        s, _ = ec.req("GET", "/api/me")
        check("session revoked by admin password reset -> 401", s == 401, s)
        s, _ = c.req("GET", "/api/me")
        check("admin's own session survives the reset", s == 200, s)

        # --- oversized / non-object bodies are refused ---
        conn = http.client.HTTPConnection(HOST, port, timeout=5)
        conn.putrequest("POST", "/api/login")
        conn.putheader("Content-Length", str(50 * 1024 * 1024))
        conn.endheaders()
        r = conn.getresponse(); r.read(); conn.close()
        check("oversized body rejected unread -> 400", r.status == 400, r.status)
        check("security headers sent", r.getheader("X-Content-Type-Options") == "nosniff"
              and r.getheader("X-Frame-Options") == "DENY", r.getheaders())
        s, d = c.req("POST", "/api/people", ["not", "an", "object"])
        check("non-object JSON body -> 400", s == 400, (s, d))

        # --- delete the test person, verify cascade ---
        s, d = c.req("DELETE", f"/api/people/{new_id}")
        check("delete person -> 200", s == 200, (s, d))
        s, tree4 = c.req("GET", "/api/tree")
        check("person gone", all(p["id"] != new_id for p in tree4["people"]), new_id)
        check("child's parent link cascaded/cleared",
              all(new_id not in p["parentIds"] for p in tree4["people"]))

        s, d = c.req("POST", "/api/logout")
        check("logout -> 200", s == 200, (s, d))
        s, _ = c.req("GET", "/api/me")
        check("session invalid after logout -> 401", s == 401, s)

        # --- login rate limit holds against a parallel burst ---
        # Attempts are counted before the password check, so 20 simultaneous
        # wrong guesses from one IP can't all be evaluated. Leaves 127.0.0.1
        # locked out, so nothing below may log in.
        def bad_login(i):
            return Client(port).req("POST", "/api/login", {"username": "admin", "password": f"wrong{i}"})[0]
        with ThreadPoolExecutor(max_workers=20) as pool:
            statuses = list(pool.map(bad_login, range(20)))
        check("parallel login burst capped by the rate limit",
              statuses.count(401) <= 8 and statuses.count(429) >= 12, statuses)
        s, _ = Client(port).req("POST", "/api/login", {"username": "admin", "password": "testpass123"})
        check("locked-out IP refused even with the right password -> 429", s == 429, s)

        # --- static ---
        s, body = c.req("GET", "/index.html")
        check("static index.html served", s == 200, s)
        conn = http.client.HTTPConnection(HOST, port, timeout=5)
        conn.request("GET", "/css/app.css")
        r = conn.getresponse(); r.read()
        check("app.css served as text/css", r.status == 200 and "css" in r.getheader("Content-Type", ""), r.status)
        conn.request("GET", "/js/app.js")
        r = conn.getresponse(); r.read()
        check("app.js served as javascript", r.status == 200 and "javascript" in r.getheader("Content-Type", ""), r.status)
        # static assets must force revalidation so a deploy isn't masked by
        # the browser cache (stale js/* after a deploy was a real bug)
        last_mod = r.getheader("Last-Modified")
        check("app.js sent with Cache-Control: no-cache", r.getheader("Cache-Control") == "no-cache", r.getheader("Cache-Control"))
        check("app.js sent with Last-Modified", bool(last_mod), last_mod)
        conn.request("GET", "/js/app.js", headers={"If-Modified-Since": last_mod})
        r = conn.getresponse(); r.read()
        check("app.js revalidates to 304", r.status == 304, r.status)
        conn.close()
        s, body = c.req("GET", "/../server.py")
        check("path traversal blocked", s in (403, 404), s)
        s, body = c.req("GET", "/robots.txt")
        check("robots.txt served", s == 200 and b"Disallow" in body, s)
        # the background texture is served locally so the app works with no internet
        s, body = c.req("GET", "/css/cubes.svg")
        check("css/cubes.svg served locally", s == 200 and body.startswith(b"<svg"), s)
        # allowlist, not just traversal blocking: files that genuinely sit
        # under ROOT (server.py, schema.sql) must still be unreachable
        s, d = c.req("GET", "/server.py")
        check("server.py not servable", s == 404, (s, d))
        s, d = c.req("GET", "/schema.sql")
        check("schema.sql not servable", s == 404, (s, d))

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        out = proc.stdout.read() if proc.stdout else ""
        if FAIL:
            print("\n--- server output ---\n" + out)
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
