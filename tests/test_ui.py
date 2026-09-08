"""Browser smoke test for the family-tree frontend.

Boots the real server against a throwaway DB copy, drives Chromium through
the main flows, and fails on any console error / page exception. Run:
    python3 tests/test_ui.py
"""
import http.client
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pg_fixture import reset_and_seed  # noqa: E402
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
    database_url = reset_and_seed()

    for name in ("server.py", "schema.sql", "index.html", "version.json"):
        shutil.copy(ROOT / name, Path(tmp) / name)
    shutil.copytree(ROOT / "js", Path(tmp) / "js")
    shutil.copytree(ROOT / "css", Path(tmp) / "css")

    port = free_port()
    env = {**os.environ, "FAMILYTREE_ADMIN_USERNAME": "admin", "FAMILYTREE_ADMIN_PASSWORD": "testpass123",
           "FAMILYTREE_DATABASE_URL": database_url}
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

            # the help button's icon must actually render (regression: a stale
            # icons.js with no 'help-circle' entry left an empty <svg> and the
            # button looked blank)
            help_icon_shapes = page.eval_on_selector_all(
                "#btn-help-tour svg > *", "els => els.length")
            check("help button icon renders", help_icon_shapes > 0, help_icon_shapes)

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

            # build/version stamp in the sidebar footer (dev copy -> "yerel ...")
            page.wait_for_function("document.querySelector('#app-version').textContent.length > 0", timeout=3000)
            ver_txt = page.text_content("#app-version")
            check("version stamp shown", "yerel" in (ver_txt or ""), ver_txt)

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

            # --- Responsive / touch: phone viewport ---
            mob = browser.new_context(viewport={"width": 390, "height": 844},
                                      has_touch=True, is_mobile=True)
            mp = mob.new_page()
            mp.on("console", on_console)
            mp.on("pageerror", lambda e: errors.append(f"pageerror(mobile): {e}"))
            mp.goto(base + "/index.html", wait_until="networkidle")
            check("mobile: login form fits viewport",
                  mp.eval_on_selector("#login-form", "el => el.getBoundingClientRect().right <= innerWidth + 1"))
            mp.fill("#login-username", "admin")
            mp.fill("#login-password", "testpass123")
            mp.click("#btn-login-submit")
            mp.wait_for_selector(".tree-node-card[data-id]", timeout=15000)
            mp.wait_for_timeout(1200)
            mp.keyboard.press("Escape")  # dismiss tour
            mp.wait_for_timeout(300)
            check("mobile: sidebar toggle FAB visible", mp.is_visible("#btn-sidebar-toggle"))
            check("mobile: no horizontal page scroll",
                  mp.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
            check("mobile: top toolbar within viewport",
                  mp.eval_on_selector("#top-toolbar", "el => el.getBoundingClientRect().right <= innerWidth + 1"))
            # the tour opens the tools drawer on mobile — close it first
            mp.click("#btn-sidebar-toggle")
            mp.wait_for_timeout(400)

            # tapping a card raises the bottom sheet (NOT the tools drawer),
            # pinned to the bottom edge and within the viewport
            mp.click(".tree-node-card:not(.root-node)")
            mp.wait_for_timeout(500)
            check("mobile: card tap opens the details bottom sheet",
                  mp.eval_on_selector("#person-details-panel", "el => el.classList.contains('ft-sheet-open')")
                  and mp.is_visible("#person-details-panel"))
            check("mobile: card tap does not open the tools drawer",
                  mp.eval_on_selector("#app-sidebar", "el => !el.classList.contains('ft-drawer-open')"))
            check("mobile: sheet sits on the bottom edge, within the viewport",
                  mp.eval_on_selector("#person-details-panel", """el => {
                      const r = el.getBoundingClientRect();
                      return Math.abs(r.bottom - innerHeight) <= 1 && r.right <= innerWidth + 1 && r.left >= -1;
                  }"""))
            check("mobile: FAB hidden while the sheet is open",
                  not mp.is_visible("#btn-sidebar-toggle"))
            mp.click("#btn-close-details")
            mp.wait_for_timeout(500)
            check("mobile: closing details retracts the sheet",
                  mp.eval_on_selector("#person-details-panel", "el => !el.classList.contains('ft-sheet-open')")
                  and not mp.eval_on_selector("body", "el => el.classList.contains('ft-sheet-open')"))

            # tools drawer: opens only from the FAB, closes from its backdrop
            mp.click("#btn-sidebar-toggle")
            mp.wait_for_timeout(400)
            check("mobile: FAB opens the tools drawer, within the viewport",
                  mp.eval_on_selector("#app-sidebar", "el => el.classList.contains('ft-drawer-open')")
                  and mp.eval_on_selector("#app-sidebar", "el => el.getBoundingClientRect().right <= innerWidth + 1"))
            mp.click("#sidebar-backdrop", position={"x": 16, "y": 16})  # clear of the drawer
            mp.wait_for_timeout(400)
            check("mobile: backdrop tap closes the tools drawer",
                  mp.eval_on_selector("#app-sidebar", "el => !el.classList.contains('ft-drawer-open')"))

            z0 = mp.eval_on_selector("#tree-transform", "el => el.style.transform")
            mp.evaluate("""() => {
                const sc = document.getElementById('scroll-container');
                const mk = (t, ts) => { const e = new Event(t, {bubbles:true, cancelable:true});
                    e.touches = ts; e.targetTouches = ts; e.changedTouches = ts; sc.dispatchEvent(e); };
                const r = sc.getBoundingClientRect(), cx = r.left + r.width/2, cy = r.top + r.height/2;
                mk('touchstart', [{clientX:cx-40,clientY:cy},{clientX:cx+40,clientY:cy}]);
                mk('touchmove',  [{clientX:cx-120,clientY:cy},{clientX:cx+120,clientY:cy}]);
                mk('touchend', []);
            }""")
            mp.wait_for_timeout(200)
            check("mobile: two-finger pinch zooms the canvas",
                  mp.eval_on_selector("#tree-transform", "el => el.style.transform") != z0)

            # double-tap on empty canvas also zooms
            z1 = mp.eval_on_selector("#tree-transform", "el => el.style.transform")
            mp.evaluate("""() => {
                const sc = document.getElementById('scroll-container');
                const r = sc.getBoundingClientRect();
                const pt = {clientX: r.left + 8, clientY: r.top + 8};
                const fire = (type, touches, changed) => {
                    const e = new Event(type, {bubbles: true, cancelable: true});
                    e.touches = touches; e.targetTouches = touches; e.changedTouches = changed;
                    Object.defineProperty(e, 'target', {value: sc});
                    sc.dispatchEvent(e);
                };
                fire('touchstart', [pt], [pt]); fire('touchend', [], [pt]);
                fire('touchstart', [pt], [pt]); fire('touchend', [], [pt]);
            }""")
            mp.wait_for_timeout(200)
            check("mobile: double-tap on empty canvas zooms",
                  mp.eval_on_selector("#tree-transform", "el => el.style.transform") != z1)
            mob.close()

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
