"""Integration smoke test for server.py.

Runs the real server against a throwaway copy of data.sqlite on a random
port and exercises every endpoint. Run: python3 tests/test_api.py
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
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def free_port():
    s = socket.socket()
    s.bind(("localhost", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Client:
    def __init__(self, port):
        self.port = port
        self.cookie = None

    def req(self, method, path, body=None):
        conn = http.client.HTTPConnection("localhost", self.port, timeout=5)
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
    db_copy = Path(tmp) / "data.sqlite"
    shutil.copy(ROOT / "data.sqlite", db_copy)
    # Wipe accounts so ensure_initial_admin() creates one with a known password.
    import sqlite3
    _c = sqlite3.connect(db_copy)
    for t in ("Sessions", "Users"):
        try:
            _c.execute(f"DELETE FROM {t}")
        except sqlite3.OperationalError:
            pass
    _c.commit()
    _c.close()
    port = free_port()

    env = {**os.environ, "FAMILYTREE_ADMIN_USERNAME": "admin", "FAMILYTREE_ADMIN_PASSWORD": "testpass123"}
    # Run a copy of server.py pointed at the temp DB dir.
    server_py = (Path(tmp) / "server.py")
    shutil.copy(ROOT / "server.py", server_py)
    shutil.copy(ROOT / "index.html", Path(tmp) / "index.html")
    proc = subprocess.Popen(
        [sys.executable, str(server_py), str(port)],
        cwd=tmp, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        for _ in range(50):
            try:
                http.client.HTTPConnection("localhost", port, timeout=1).request("GET", "/api/me")
                break
            except OSError:
                time.sleep(0.1)

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
        check("tree loads", s == 200 and len(tree["people"]) > 500 and "roots" in tree, s)
        person0 = tree["people"][0]
        check("person has link arrays", isinstance(person0.get("spouseIds"), list) and isinstance(person0.get("parentIds"), list))

        # --- person CRUD ---
        s, created = c.req("POST", "/api/people", {"name": "Test Kişi", "gender": 1})
        check("create person -> 201", s == 201 and created["name"] == "Test Kişi", (s, created))
        new_id = created["id"]

        s, tree2 = c.req("GET", "/api/tree")
        check("new person id is unique + max+1", new_id == max(p["id"] for p in tree["people"]) + 1, new_id)

        s, updated = c.req("PATCH", f"/api/people/{new_id}", {"name": "Test Kişi 2", "note": "not"})
        check("update person -> 200", s == 200 and updated["name"] == "Test Kişi 2", (s, updated))

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
        s, root = c.req("POST", "/api/roots", {"title": "TEST KÖK", "generation": 2, "memberIds": [new_id]})
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
        s, d = ec.req("POST", "/api/people", {"name": "Editor Ekledi"})
        check("editor can create person -> 201", s == 201, (s, d))

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

        # --- static ---
        s, body = c.req("GET", "/index.html")
        check("static index.html served", s == 200, s)
        s, body = c.req("GET", "/../server.py")
        check("path traversal blocked", s in (403, 404), s)

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
