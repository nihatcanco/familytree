# Family Tree

A self-hosted, login-protected family tree. A single Python server (`server.py`)
serves a no-build vanilla-JS frontend and a small JSON API backed by PostgreSQL,
so every edit made in the browser is written straight to the database. The UI is
in English, and names, places and notes can use any characters, including Turkish
ones (`ç ğ ı İ ö ş ü`).

![The tree with one person selected: their bloodline is highlighted in generation colours, with the details panel, search and minimap on the right](docs/screenshot.png)

*The screenshot uses the made-up family from the test suite.*

## Features

- **Pan / zoom canvas** — drag to pan, Ctrl/⌘ + wheel or trackpad pinch to zoom, two-finger pinch and double-tap on touch devices.
- **Search** — matches name, surname and other attributes, folding Turkish letters (`i`/`s`/`g`/`u`/`o`/`c` also match `ı`/`ş`/`ğ`/`ü`/`ö`/`ç`); step through matches with the arrow buttons.
- **Focus mode** — click a card, then the focus icon in the details panel to show only that person's bloodline (ancestors, descendants and spouses) and fit it to the screen.
- **Relationship path** — pick any two people on the canvas and the shortest chain of relations connecting them is highlighted.
- **Minimap + SVG export** — a click-to-jump overview of the whole tree, and a button to download the currently displayed tree(s) as one vector SVG image (sharp at any zoom, no size ceiling).
- **Roots** — a root (diamond) marks the origin of an independent family line with its own editable title and generation number; descendant generations are counted down from it.
- **Dark / light theme** — toggled from the top bar; the choice is remembered per browser.
- **Guided tour** — shown automatically on first login, replayable any time from the (?) button.
- **Phone & tablet** — see [below](#phone--tablet).
- Full add / edit / delete for people and roots from the UI (see [roles](#login--accounts)), with cycle-safe parent assignment and cascading link cleanup on delete.

## Running locally

Requires Python 3 and a reachable **PostgreSQL**. The frontend has no build step —
all CSS, JS, icons and images are served as-is by `server.py`, and fonts are the
system's own. The app makes no requests to any outside host, so it works fully
offline (internet is only needed to install the Python packages and pull the
Docker images).

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# a local Postgres for development (or bring your own and set the URL below):
docker compose -f docker-compose.test.yml up -d   # postgres on :5433
export FAMILYTREE_DATABASE_URL=postgresql://familytree:familytree@localhost:5433/familytree_test

python server.py                  # then open http://localhost:8000
```

`server.py` applies `schema.sql` on startup, so it runs against an empty database —
you enter the tree through the UI. Editing needs this server: a plain static file
server (`npx serve`, `python3 -m http.server`, …) will load the page but can't log
in or save changes.

Pass a different port if 8000 is taken: `python3 server.py 8080`.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FAMILYTREE_DATABASE_URL` | `postgresql:///familytree` | PostgreSQL connection URL |
| `FAMILYTREE_HOST` | `127.0.0.1` | Interface to listen on (`0.0.0.0` inside Docker) |
| `FAMILYTREE_SECURE_COOKIES` | unset | `1` marks the session cookie `Secure` — only behind HTTPS |
| `FAMILYTREE_ADMIN_USERNAME` | `admin` | First admin's username (empty database only) |
| `FAMILYTREE_ADMIN_PASSWORD` | random | First admin's password (empty database only) |

### Tests

```bash
.venv/bin/pip install -r requirements-dev.txt && .venv/bin/playwright install chromium
docker compose -f docker-compose.test.yml up -d
.venv/bin/python tests/test_api.py   # API integration test
.venv/bin/python tests/test_ui.py    # browser smoke test (Chromium via Playwright)
```

Both reset the database at `TEST_DATABASE_URL` (default: the docker-compose one on
`:5433`), so never point that at real data. GitHub Actions runs both on every push
to `main` and every pull request (`.github/workflows/tests.yml`).

## Deployment

The venv setup above is for development only. Production runs in Docker:
`docker-compose.yml` (app + PostgreSQL), built, tested and deployed by the
`Jenkinsfile` on a Windows agent — see [DEPLOY.md](DEPLOY.md) for the server and
job setup. To run that same stack locally:

```bash
POSTGRES_PASSWORD=devpass docker compose up -d --build   # then open http://localhost:8000
```

Settings such as the host port and bind address are Jenkins environment variables,
listed in [DEPLOY.md](DEPLOY.md#3-settings).

## Login & accounts

The app requires a login. On the very first run (empty `Users` table), the server creates an `admin` account with a random password and prints the username and password once to the console — copy them before they scroll away, they are never shown again.

Set `FAMILYTREE_ADMIN_USERNAME` / `FAMILYTREE_ADMIN_PASSWORD` to pick them yourself instead.

There are three roles:
- **admin** — everything below, plus the user-management panel (shield icon, top right): add/remove accounts, change roles, link an account to its corresponding person in the tree.
- **editor** — can add/edit/delete people and roots, no access to user management.
- **viewer** — read-only.

Each account can optionally be linked to a person in the tree (its `personId`), set from the admin panel — this is just bookkeeping ("who is this login for") and doesn't affect tree logic.

Any logged-in user can change their own password (key icon, top right — needs the current password). Admins can also reset any account's password from the user-management panel (the reset-password action under each user, no current password needed). Either way, every other session of that account is logged out.

## Security

What the server does:

- **Passwords** are stored as salted PBKDF2-SHA256 hashes. Login attempts are rate-limited per client IP (8 failures per 5 minutes, counted before the password is checked, so a burst of parallel requests can't get past it), and a wrong username costs the same time as a wrong password.
- **Sessions** are random tokens in the `Sessions` table, sent as an `HttpOnly`, `SameSite=Strict` cookie, valid for 7 days. Logout, deleting a user and changing a password revoke them server-side. `SameSite=Strict` is the CSRF defense.
- **Authorization** is checked per route against the role stored in the database, so a role change applies to existing sessions immediately.
- **SQL** is always parameterised.
- **Static files** are served from an allowlist (`index.html`, `version.json`, `robots.txt`, `css/`, `js/`), checked against the resolved path — `server.py`, `schema.sql`, `.git`, `tests/` and the rest are never reachable over HTTP. `robots.txt` tells crawlers not to index the app.
- **Responses** carry `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. Request bodies over 1 MB are refused, and internal errors return a generic message (details go to the server log).
- The frontend escapes all user-entered data before inserting it into the page.

What it doesn't do: `server.py` only speaks **plain HTTP**, so as deployed by
default, passwords and session cookies cross the network unencrypted — acceptable
on a trusted LAN, not on the open internet. For internet exposure, put an HTTPS
reverse proxy (Caddy, nginx, …) in front of it and set `FAMILYTREE_SECURE_COOKIES=1`
(see [DEPLOY.md](DEPLOY.md#5-https-and-internet-exposure)). Behind a proxy or
Docker's port forwarding, the login rate limit may see every client as the same
IP — then 8 wrong guesses from anyone lock everyone out for up to 5 minutes.

## Phone & tablet

Below 900px wide the right-hand toolbar collapses into a slide-in drawer,
toggled by the floating button at the bottom-right (it also opens on its own
when you tap a card, and closes when you close the details panel). The canvas
takes one-finger drag to pan and two-finger pinch to zoom, and the tree opens
zoomed out to fit the screen. Everything else — login, add/edit person, the
admin panel, the guided tour — works at phone width.

## Layout

```
server.py               HTTP server + /api (route table, one write lock, psycopg pool)
schema.sql              PostgreSQL DDL, applied on startup (idempotent)
index.html              markup only
robots.txt              blocks search-engine indexing
css/app.css             whole stylesheet (utilities + tree layout + dark theme)
js/api.js               fetch() wrapper for /api
js/tree-model.js        flat rows -> hierarchy -> tidy-tree layout (no DOM)
js/card-view.js         person/root node -> card HTML / SVG fragment
js/util.js              pure helpers (escaping, Turkish folding, colours, …)
js/icons.js             inline SVG icon set
js/tour.js              guided overlay tutorial (first login + the "?" button)
js/app.js               everything interactive (render pipeline, connectors, focus,
                        search, minimap, details panel, auth, admin panel)
tests/                  test_api.py (API integration), test_ui.py (browser smoke test)
requirements-dev.txt    runtime deps + Playwright, for the tests
.github/workflows/      GitHub Actions: runs both test suites
Dockerfile              base / test / app image targets
docker-compose.yml      production stack: app + postgres:18
docker-compose.test.yml scratch Postgres for the tests (:5433)
Jenkinsfile             build, test, deploy pipeline (Windows agent, Docker Desktop)
sync-db-password.sql    re-applies the db password from the Jenkins credential on deploy
DEPLOY.md               server + Jenkins setup
```

## License

[MIT](LICENSE). The bundled Lucide icons and the Tailwind-derived base CSS keep
their own licenses, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
