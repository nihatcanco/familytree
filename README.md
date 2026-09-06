Requires Python 3 (stdlib only, no extra installs).

```bash
python3 server.py
# then open http://localhost:8000
```

This serves the app *and* a small `/api` backed directly by `data.sqlite`, so editing a person in the UI ("Kişi Detayları" → pencil icon → Kaydet) writes straight to that file on disk. Editing needs this server — a plain static file server (`npx serve`, `python3 -m http.server`, `php -S`, etc.) will load the tree fine but can't save changes.

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
