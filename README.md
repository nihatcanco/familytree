Requires Python 3 and a reachable **PostgreSQL**. The frontend has no build step —
all CSS and JS is served as-is, no CDN dependencies.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# a local Postgres for development (or bring your own and set the URL below):
docker compose -f docker-compose.test.yml up -d   # postgres on :5433
export FAMILYTREE_DATABASE_URL=postgresql://familytree:familytree@localhost:5433/familytree_test

python migrate_sqlite_to_pg.py    # one-time: load schema.sql + seed from data.sqlite
python server.py                  # then open http://localhost:8000
```

`FAMILYTREE_DATABASE_URL` defaults to `postgresql:///familytree`. `server.py`
applies `schema.sql` on startup, so `migrate_sqlite_to_pg.py` is only needed if you
want the tree data that ships in `data.sqlite` (otherwise you start empty).

This serves the app *and* a small `/api` backed by PostgreSQL, so editing a person in the UI ("Kişi Detayları" → pencil icon → Kaydet) writes straight to the database. Editing needs this server — a plain static file server (`npx serve`, `python3 -m http.server`, `php -S`, etc.) will load the tree fine but can't save changes.

Pass a different port if 8000 is taken: `python3 server.py 8080`.

## Login & accounts

The app requires a login. On the very first run (empty `Users` table), the server creates an `admin` account with a random password and prints it once to the console — copy it before it scrolls away, it is never shown again:

```
 İlk admin hesabı oluşturuldu -- bu bilgiler bir daha gösterilmeyecek:
   Kullanıcı adı : admin
   Şifre         : <random>
```

Override the bootstrap username/password with `FAMILYTREE_ADMIN_USERNAME` / `FAMILYTREE_ADMIN_PASSWORD` env vars if you want to pick them yourself instead.

There are three roles:
- **admin** — everything below, plus the user-management panel (shield icon, top right): add/remove accounts, change roles, link an account to its corresponding person in the tree.
- **editor** — can add/edit/delete people and roots, no access to user management.
- **viewer** — read-only.

Each account can optionally be linked to a person in the tree (its `personId`), set from the admin panel — this is just bookkeeping ("who is this login for") and doesn't affect tree logic.

Any logged-in user can change their own password (key icon, top right — needs the current password). Admins can also reset any account's password from the user-management panel ("Şifre sıfırla" under each user, no current password needed) — useful if someone forgets theirs.

## Running this on the internet

`server.py` only ever speaks plain HTTP — for real internet exposure, put it behind a reverse proxy (nginx, Caddy, etc.) that terminates HTTPS, then set `FAMILYTREE_SECURE_COOKIES=1` when starting the server so the session cookie is marked `Secure`. Without that env var the cookie still works over plain HTTP (e.g. local/LAN use), but shouldn't be relied on over the open internet.

## Layout

```
server.py         HTTP server + /api (route table, one write lock, psycopg pool)
schema.sql        PostgreSQL DDL, applied on startup (idempotent)
migrate_sqlite_to_pg.py  one-time: create schema + seed from data.sqlite
index.html        markup only
css/app.css       whole stylesheet (utilities + tree layout + dark theme)
js/api.js         fetch() wrapper for /api
js/tree-model.js  flat rows -> hierarchy -> tidy-tree layout (no DOM)
js/card-view.js   person/root node -> card HTML / SVG fragment
js/util.js        pure helpers (escaping, Turkish folding, colours, …)
js/icons.js       inline SVG icon set (was the Lucide CDN)
js/app.js         everything interactive (render pipeline, connectors, focus,
                  search, minimap, details panel, auth, admin panel)
tests/            python3 tests/test_api.py  — API integration (needs a test Postgres)
                  python3 tests/test_ui.py   — browser smoke test (needs playwright)
                  both reset TEST_DATABASE_URL (default: the docker-compose one on :5433)
```

## Phone & tablet

Below 900px wide the right-hand toolbar collapses into a slide-in drawer,
toggled by the floating button at the bottom-right (it also opens on its own
when you tap a card, and closes when you close the details panel). The canvas
takes one-finger drag to pan and two-finger pinch to zoom, and the tree opens
zoomed out to fit the screen. Everything else — login, add/edit person, the
admin panel, the guided tour — works at phone width.
