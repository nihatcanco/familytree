"""Browser smoke test for the family-tree frontend.

Boots the real server against a throwaway DB copy, drives Chromium through
the main flows, and fails on any console error / page exception. Run:
    python3 tests/test_ui.py
"""
import http.client
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PASS = FAIL = 0


def check(label, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {label}")
    else:
        FAIL += 1
        print(f"  FAIL {label} {extra}")


def free_port():
    s = socket.socket(); s.bind(("localhost", 0)); p = s.getsockname()[1]; s.close(); return p


def main():
    tmp = tempfile.mkdtemp()
    db_copy = Path(tmp) / "data.sqlite"
    shutil.copy(ROOT / "data.sqlite", db_copy)
    c = sqlite3.connect(db_copy)
    for t in ("Sessions", "Users"):
        try:
            c.execute(f"DELETE FROM {t}")
        except sqlite3.OperationalError:
            pass
    c.commit(); c.close()

    for name in ("server.py", "index.html"):
        shutil.copy(ROOT / name, Path(tmp) / name)
    shutil.copytree(ROOT / "js", Path(tmp) / "js")
    shutil.copytree(ROOT / "css", Path(tmp) / "css")

    port = free_port()
    env = {**os.environ, "FAMILYTREE_ADMIN_USERNAME": "admin", "FAMILYTREE_ADMIN_PASSWORD": "testpass123"}
    proc = subprocess.Popen([sys.executable, str(Path(tmp) / "server.py"), str(port)],
                            cwd=tmp, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    base = f"http://localhost:{port}"
    try:
        for _ in range(50):
            try:
                http.client.HTTPConnection("localhost", port, timeout=1).request("GET", "/index.html")
                break
            except OSError:
                time.sleep(0.1)

        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            errors = []

            def on_console(m):
                if m.type != "error":
                    return
                # The pre-auth GET /api/me is expected to 401; the app handles
                # it (getMe() returns null). The browser still logs the failed
                # response as a console error — ignore just that one.
                loc = (m.location or {}).get("url", "") if hasattr(m, "location") else ""
                if "401" in m.text and ("/api/me" in loc or "/api/me" in m.text):
                    return
                errors.append(f"console.{m.type}: {m.text} @ {loc}")

            page.on("console", on_console)
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

            page.goto(base + "/index.html", wait_until="networkidle")

            check("login form visible", page.is_visible("#login-form"))
            page.fill("#login-username", "admin")
            page.fill("#login-password", "testpass123")
            page.click("#btn-login-submit")

            page.wait_for_selector(".tree-node-card[data-id]", timeout=15000)
            page.wait_for_timeout(1500)  # let layout + connectors settle

            # the guided tour pops up on every fresh login; dismiss it before
            # driving the app (its backdrop would swallow clicks otherwise)
            check("guided tour shows on login", page.is_visible("#ft-tour-root"))
            page.keyboard.press("Escape")
            page.wait_for_selector("#ft-tour-root", state="detached", timeout=3000)

            # and it can be reopened from the help button
            page.click("#btn-help-tour")
            check("tour reopens from help button", page.is_visible("#ft-tour-card"))
            page.keyboard.press("Escape")
            page.wait_for_selector("#ft-tour-root", state="detached", timeout=3000)

            cards = page.eval_on_selector_all(".tree-node-card[data-id]", "els => els.length")
            check("many cards rendered", cards > 400, cards)

            connectors = page.eval_on_selector_all("#cross-tree-links path", "els => els.length")
            check("connector paths drawn", connectors > 100, connectors)

            icons = page.eval_on_selector_all("svg[aria-hidden]", "els => els.length")
            check("local icons rendered (no lucide CDN)", icons > 5, icons)

            # a card should actually be 220px wide (CSS applied, no FOUC hack needed)
            w = page.eval_on_selector(".tree-node-card:not(.root-node)", "el => el.getBoundingClientRect().width")
            check("card is 220px wide (app.css applied)", abs(w - 220) < 2, w)

            count_txt = page.text_content("#people-count")
            check("people count shown", "kişi" in (count_txt or ""), count_txt)

            # click a card -> details panel opens
            page.click(".tree-node-card:not(.root-node)")
            page.wait_for_selector("#person-details-panel:not(.hidden)", timeout=5000)
            check("details panel opens on card click", page.is_visible("#person-details-content"))
            highlighted = page.eval_on_selector_all(".tree-node-card.highlighted, .tree-node-card.highlighted-gen", "e=>e.length")
            check("bloodline highlight applied", highlighted >= 1, highlighted)

            # search
            page.fill("#search-input", "a")
            page.wait_for_timeout(600)
            matches = page.eval_on_selector_all(".search-match", "e=>e.length")
            check("search finds matches", matches > 0, matches)
            page.click("#btn-search-clear")

            # focus mode toggle
            page.click("#btn-close-details")
            page.click(".tree-node-card:not(.root-node)")
            page.wait_for_selector("#person-details-panel:not(.hidden)")
            page.click("#btn-focus")
            page.wait_for_timeout(1200)
            focus_cards = page.eval_on_selector_all(".tree-node-card[data-id]", "e=>e.length")
            check("focus mode prunes the tree", 0 < focus_cards <= cards, (focus_cards, cards))
            page.click("#btn-focus")
            page.wait_for_timeout(1200)

            # theme toggle
            page.click("#btn-theme-toggle")
            is_dark = page.eval_on_selector("html", "el => el.classList.contains('dark')")
            check("theme toggles to dark", is_dark)
            bg = page.eval_on_selector("body", "el => getComputedStyle(el).backgroundColor")
            check("dark body background applied", bg in ("rgb(15, 23, 42)", "rgba(15, 23, 42, 1)"), bg)
            page.click("#btn-theme-toggle")

            # minimap canvas has been drawn to
            has_pixels = page.evaluate("""() => {
                const c = document.getElementById('minimap-canvas');
                if (!c || !c.width) return false;
                const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
                for (let i=3;i<d.length;i+=4) if (d[i]!==0) return true;
                return false;
            }""")
            check("minimap canvas rendered", has_pixels)

            # relationship picker enters without error
            page.click("#btn-relationship")
            check("relationship picker opens", page.is_visible("#relationship-status"))
            page.click("#btn-relationship-cancel")

            check("no console errors / page exceptions", not errors, "\n     " + "\n     ".join(errors))
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        srv = proc.stdout.read() if proc.stdout else ""
        if FAIL:
            print("\n--- server output ---\n" + srv)
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
